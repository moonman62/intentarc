Set-StrictMode -Version Latest

$script:IntentArcPreflightEnvelopeWasDotSourced = [string]::Equals($MyInvocation.InvocationName, '.', [StringComparison]::Ordinal)
$script:IntentArcPreflightEnvelopeProductionArguments = [string[]] @($args)
$script:IntentArcPreflightExecutionAttemptId = 'phase1-preflight-envelope-20260902-01'
$script:IntentArcPreflightExecutionControllerRunId = 'phase1-preflight-20260901-06'
$script:IntentArcPreflightExecutionManifestPath = 'C:\projects\Project Manager\.superpowers\preflight-execution-authorizations\phase1-preflight-envelope-20260902-01.json'
$script:IntentArcPreflightExecutionEnvelopePath = 'C:\projects\Project Manager\scripts\desktop-release-preflight-once.ps1'
$script:IntentArcPreflightExecutionPowerShellPath = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
$script:IntentArcPreflightExecutionAuthorizationKeys = [string[]] @(
    'schema', 'attemptId', 'controllerRunId', 'jobName', 'canonicalPath', 'branch', 'expectedCommit',
    'authorizationManifestPath', 'envelopePath', 'envelopeSha256', 'controllerPath', 'controllerSha256',
    'gitPath', 'gitSha256', 'nodePath', 'nodeSha256', 'cmdPath', 'cmdSha256', 'pnpmPath', 'pnpmSha256',
    'outerPowerShellPath', 'outerPowerShellSha256', 'maximumControllerStdoutBytes',
    'maximumControllerStderrBytes', 'maximumAttempts', 'retryAuthorized', 'restoreOnlyAuthorized',
    'signedReleaseAuthorized', 'createdAtUtc'
)
$script:IntentArcPreflightEnvelopeOperationNames = [string[]] @(
    'BindExecutionInputs', 'GetRepositoryState', 'GuardBoundaries', 'ProbeId06Unused',
    'CreateAttemptRoot', 'CopyAuthorization', 'WriteConsumptionAttempted', 'StartController',
    'WriteControllerStarted', 'FinalizeControllerAttempt'
)
$script:IntentArcPreflightEnvelopeOperationCategories = [ordered]@{
    BindExecutionInputs = 'observation'
    GetRepositoryState = 'observation'
    GuardBoundaries = 'observation'
    ProbeId06Unused = 'observation'
    CreateAttemptRoot = 'evidence-mutation'
    CopyAuthorization = 'evidence-mutation'
    WriteConsumptionAttempted = 'evidence-mutation'
    StartController = 'controller-launch'
    WriteControllerStarted = 'evidence-mutation'
    FinalizeControllerAttempt = 'evidence-mutation'
}
$script:IntentArcPreflightEnvelopeEvidenceRetentionState = [pscustomobject]@{ Value = $null }
$script:IntentArcPreflightTerminalAuditOperationNames = [string[]] @('ReadAuditEvidence', 'ObserveGit', 'WriteAuditResult')
$script:IntentArcPreflightAuditPrecedence = [string[]] @(
    'authorization-invalid', 'attempt-not-consumed', 'attempt-evidence-invalid',
    'controller-not-started', 'controller-outcome-uncertain', 'controller-capture-invalid',
    'controller-result-invalid', 'controller-state-invalid', 'controller-receipt-invalid',
    'child-settlement-invalid', 'out-restoration-invalid', 'cleanup-invalid',
    'repository-invalid', 'binding-invalid', 'audit-infrastructure-invalid'
)
$script:IntentArcPreflightExecutionRefusalJson = '{"schema":"intentarc.preflight-execution-audit/v1","status":"TERMINAL-NOT-PASS","category":"authorization-invalid","attemptId":"phase1-preflight-envelope-20260902-01","controllerRunId":"phase1-preflight-20260901-06","expectedCommit":null,"attemptConsumed":false,"controllerStarted":false,"controllerExitCode":null,"resultSha256":null,"stateSha256":null,"receiptSha256":null,"outRestored":false,"cleanupComplete":false,"gitClean":false,"bindingsValid":false}'

function Throw-IntentArcPreflightExecutionAuthorizationInvalid { throw 'authorization-invalid' }

function Initialize-IntentArcPreflightExecutionNative {
    if ($null -ne ('IntentArc.PreflightEnvelope.PinnedManifestFile' -as [type])) { return }
    Add-Type -TypeDefinition @'
using System;
using System.Collections;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

namespace IntentArc.PreflightEnvelope {
  public sealed class TestHooks {
    public int ManifestOpenCount { get; set; }
    public int BoundOpenCount { get; set; }
    public int FaultApplications { get; set; }
    public string ManifestInitialObservationFault { get; set; }
    public string ManifestPostReadObservationFault { get; set; }
    public string BoundInitialFaultName { get; set; }
    public string BoundInitialObservationFault { get; set; }
    public string BoundPostReadFaultName { get; set; }
    public string BoundPostReadObservationFault { get; set; }
    public string DisposeFaultName { get; set; }
  }

  public static class PathRules {
    private static bool IsSeparator(char value) { return value == '\\' || value == '/'; }
    private static bool HasUncServerAndShare(string path, int start) {
      int serverEnd = path.IndexOf('\\', start);
      if (serverEnd <= start) return false;
      int shareStart = serverEnd + 1;
      if (shareStart >= path.Length || path[shareStart] == '\\') return false;
      int shareEnd = path.IndexOf('\\', shareStart);
      return shareEnd < 0 || shareEnd > shareStart;
    }
    public static bool IsFullyQualifiedWindowsPath(string path) {
      if (String.IsNullOrEmpty(path)) return false;
      if (path.Length >= 3 && Char.IsLetter(path[0]) && path[1] == ':' && IsSeparator(path[2])) return true;
      if (path.StartsWith("\\\\?\\UNC\\", StringComparison.OrdinalIgnoreCase)) return HasUncServerAndShare(path, 8);
      if (path.StartsWith("\\\\?\\", StringComparison.Ordinal) && path.Length >= 7 && Char.IsLetter(path[4]) && path[5] == ':' && IsSeparator(path[6])) return true;
      return path.StartsWith("\\\\", StringComparison.Ordinal) && HasUncServerAndShare(path, 2);
    }
  }

  public sealed class TestContract {
    private readonly object marker;
    public bool Internal { get { return true; } }
    public string Root { get; private set; }
    public IDictionary ExecutableBindings { get; private set; }
    public TestHooks TestHooks { get; private set; }

    internal TestContract(string root, IDictionary bindings, object expectedMarker) {
      Root = root;
      marker = expectedMarker;
      Dictionary<string, string> copy = new Dictionary<string, string>(StringComparer.Ordinal);
      foreach (DictionaryEntry item in bindings) copy.Add((string)item.Key, (string)item.Value);
      ExecutableBindings = new ReadOnlyDictionary<string, string>(copy);
      TestHooks = new TestHooks();
    }

    internal bool HasMarker(object expectedMarker) { return Object.ReferenceEquals(marker, expectedMarker); }
  }

  public static class TestContractFactory {
    private static readonly object marker = new object();
    private static readonly object registryLock = new object();
    private static readonly HashSet<TestContract> issued = new HashSet<TestContract>();
    private static readonly string[] names = new string[] { "envelope", "controller", "git", "node", "cmd", "pnpm", "host" };

    public static TestContract Create(string root, IDictionary bindings) {
      if (!PathRules.IsFullyQualifiedWindowsPath(root) || bindings == null || bindings.Count != names.Length) {
        throw new InvalidOperationException("authorization-invalid");
      }
      foreach (string name in names) {
        if (!bindings.Contains(name) || !(bindings[name] is string) || !PathRules.IsFullyQualifiedWindowsPath((string)bindings[name])) {
          throw new InvalidOperationException("authorization-invalid");
        }
      }
      foreach (DictionaryEntry item in bindings) {
        if (!(item.Key is string) || Array.IndexOf(names, (string)item.Key) < 0) throw new InvalidOperationException("authorization-invalid");
      }
      TestContract contract = new TestContract(root, bindings, marker);
      lock (registryLock) issued.Add(contract);
      return contract;
    }

    public static bool IsIssued(object candidate) {
      TestContract contract = candidate as TestContract;
      if (contract == null || !contract.HasMarker(marker)) return false;
      lock (registryLock) return issued.Contains(contract);
    }
  }

  public static class Native {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true, EntryPoint="GetCommandLineW")]
    public static extern IntPtr GetCommandLineW();
    [DllImport("shell32.dll", CharSet=CharSet.Unicode, SetLastError=true, EntryPoint="CommandLineToArgvW")]
    public static extern IntPtr CommandLineToArgvW(string commandLine, out int count);
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true, EntryPoint="QueryFullProcessImageNameW")]
    public static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder path, ref uint size);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true, EntryPoint="CreateFileW")]
    internal static extern IntPtr CreateFileW(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true, EntryPoint="GetFinalPathNameByHandleW")]
    internal static extern uint GetFinalPathNameByHandleW(IntPtr handle, StringBuilder path, uint length, uint flags);
    [DllImport("kernel32.dll", SetLastError=true)]
    internal static extern bool GetFileInformationByHandle(IntPtr handle, out ByHandleFileInformation information);
    [DllImport("kernel32.dll", SetLastError=true)]
    internal static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError=true)]
    internal static extern bool ReadFile(IntPtr handle, byte[] buffer, uint bytesToRead, out uint bytesRead, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError=true)]
    internal static extern bool WriteFile(IntPtr handle, byte[] buffer, uint bytesToWrite, out uint bytesWritten, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError=true)]
    internal static extern bool FlushFileBuffers(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError=true)]
    internal static extern bool SetFilePointerEx(IntPtr handle, long distance, out long newPosition, uint moveMethod);
    [DllImport("kernel32.dll", SetLastError=true)]
    internal static extern bool SetFileInformationByHandle(IntPtr handle, uint informationClass, IntPtr information, uint size);
    [DllImport("ntdll.dll")]
    internal static extern int NtSetInformationFile(IntPtr handle, out IoStatusBlock ioStatus, IntPtr information, uint size, int informationClass);
    [DllImport("ntdll.dll")]
    internal static extern int NtCreateFile(out IntPtr handle, uint desiredAccess, ref ObjectAttributes attributes,
      out IoStatusBlock ioStatus, IntPtr allocationSize, uint fileAttributes, uint shareAccess,
      uint createDisposition, uint createOptions, IntPtr eaBuffer, uint eaLength);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true, EntryPoint="OpenJobObjectW")]
    internal static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError=true)]
    internal static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
    [DllImport("kernel32.dll", SetLastError=true)]
    internal static extern bool GetProcessTimes(IntPtr process, out System.Runtime.InteropServices.ComTypes.FILETIME creation,
      out System.Runtime.InteropServices.ComTypes.FILETIME exit, out System.Runtime.InteropServices.ComTypes.FILETIME kernel,
      out System.Runtime.InteropServices.ComTypes.FILETIME user);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true, EntryPoint="ConvertStringSecurityDescriptorToSecurityDescriptorW")]
    internal static extern bool ConvertStringSecurityDescriptor(string text, uint revision, out IntPtr descriptor, out uint size);
    [DllImport("advapi32.dll", SetLastError=true)]
    internal static extern bool GetSecurityDescriptorOwner(IntPtr descriptor, out IntPtr owner, out bool defaulted);
    [DllImport("advapi32.dll", SetLastError=true)]
    internal static extern bool GetSecurityDescriptorDacl(IntPtr descriptor, out bool present, out IntPtr dacl, out bool defaulted);
    [DllImport("advapi32.dll", SetLastError=true)]
    internal static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
    [DllImport("advapi32.dll", SetLastError=true)]
    internal static extern uint GetSecurityInfo(IntPtr handle, uint objectType, uint securityInformation,
      out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr securityDescriptor);
    [DllImport("advapi32.dll", SetLastError=true)]
    internal static extern uint SetSecurityInfo(IntPtr handle, uint objectType, uint securityInformation,
      IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
  }

  [StructLayout(LayoutKind.Sequential)]
  internal struct UnicodeString {
    internal ushort Length;
    internal ushort MaximumLength;
    internal IntPtr Buffer;
  }

  [StructLayout(LayoutKind.Sequential)]
  internal struct ObjectAttributes {
    internal uint Length;
    internal IntPtr RootDirectory;
    internal IntPtr ObjectName;
    internal uint Attributes;
    internal IntPtr SecurityDescriptor;
    internal IntPtr SecurityQualityOfService;
  }

  [StructLayout(LayoutKind.Sequential)]
  internal struct ByHandleFileInformation {
    public uint Attributes;
    public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
    public uint VolumeSerialNumber;
    public uint FileSizeHigh;
    public uint FileSizeLow;
    public uint NumberOfLinks;
    public uint FileIndexHigh;
    public uint FileIndexLow;
  }

  [StructLayout(LayoutKind.Sequential)]
  internal struct IoStatusBlock {
    public IntPtr Status;
    public UIntPtr Information;
  }

  public sealed class FileObservation {
    public string FinalPath;
    public uint VolumeSerialNumber;
    public ulong FileId;
    public bool IsDirectory;
    public bool IsReparsePoint;
  }

  public sealed class PinnedManifestFile : IDisposable {
    private SafeFileHandle safeHandle;
    private FileStream stream;
    private FileObservation initialObservation;
    private string postReadFault;
    private List<PinnedManifestFile> retainedFiles = new List<PinnedManifestFile>();
    private bool throwOnDispose;
    private bool disposed;

    public string LiteralPath { get; private set; }
    public string ExpectedFinalPath { get; private set; }
    public string FinalPath { get { return initialObservation.FinalPath; } }
    public string Identity { get { return initialObservation.VolumeSerialNumber.ToString("x8") + ":" + initialObservation.FileId.ToString("x16"); } }
    public FileStream Stream { get { EnsureOpen(); return stream; } }

    public PinnedManifestFile(string literalPath, string expectedFinalPath, string initialFault, string postFault)
      : this(literalPath, expectedFinalPath, initialFault, postFault, false) { }

    public PinnedManifestFile(string literalPath, string expectedFinalPath, string initialFault, string postFault, bool disposeFault) {
      if (!PathRules.IsFullyQualifiedWindowsPath(literalPath) || !PathRules.IsFullyQualifiedWindowsPath(expectedFinalPath)) throw new InvalidOperationException("authorization-invalid");
      LiteralPath = literalPath;
      ExpectedFinalPath = NormalizeExpectedPath(expectedFinalPath);
      postReadFault = postFault;
      throwOnDispose = disposeFault;
      IntPtr rawHandle = Native.CreateFileW(literalPath, 0x80000000u, 0x00000001u, IntPtr.Zero, 3u, 0x00200000u, IntPtr.Zero);
      if (rawHandle == new IntPtr(-1)) throw new InvalidOperationException("authorization-invalid");
      try {
        FileObservation observed = Observe(rawHandle);
        ApplyFault(observed, initialFault);
        ValidateAdmissible(observed);
        initialObservation = observed;
        safeHandle = new SafeFileHandle(rawHandle, true);
        rawHandle = IntPtr.Zero;
        stream = new FileStream(safeHandle, FileAccess.Read);
      } catch {
        if (stream != null) stream.Dispose();
        else if (safeHandle != null) safeHandle.Dispose();
        throw;
      } finally {
        if (rawHandle != IntPtr.Zero) Native.CloseHandle(rawHandle);
      }
    }

    public byte[] ReadBoundedAndRevalidate(int maximumBytes) {
      EnsureOpen();
      if (maximumBytes < 1 || stream.Position != 0) throw new InvalidOperationException("authorization-invalid");
      MemoryStream bytes = new MemoryStream();
      byte[] buffer = new byte[81920];
      try {
        while (true) {
          int remainingWithSentinel = maximumBytes - checked((int)bytes.Length) + 1;
          int requested = Math.Min(buffer.Length, remainingWithSentinel);
          int read = stream.Read(buffer, 0, requested);
          if (read == 0) break;
          if (bytes.Length + read > maximumBytes) throw new InvalidOperationException("authorization-invalid");
          bytes.Write(buffer, 0, read);
        }
        FileObservation observed = Observe(safeHandle.DangerousGetHandle());
        ApplyFault(observed, postReadFault);
        ValidateAdmissible(observed);
        if (!String.Equals(observed.FinalPath, initialObservation.FinalPath, StringComparison.OrdinalIgnoreCase) ||
            observed.VolumeSerialNumber != initialObservation.VolumeSerialNumber || observed.FileId != initialObservation.FileId ||
            observed.IsDirectory != initialObservation.IsDirectory || observed.IsReparsePoint != initialObservation.IsReparsePoint) {
          throw new InvalidOperationException("authorization-invalid");
        }
        return bytes.ToArray();
      } finally { bytes.Dispose(); }
    }

    public void Retain(PinnedManifestFile file) {
      EnsureOpen();
      if (file == null || Object.ReferenceEquals(file, this)) throw new InvalidOperationException("authorization-invalid");
      file.EnsureOpen();
      retainedFiles.Add(file);
    }

    private static string NormalizeExpectedPath(string path) {
      string full = Path.GetFullPath(path.Replace('/', '\\'));
      if (full.StartsWith("\\\\?\\", StringComparison.Ordinal)) return full;
      if (full.StartsWith("\\\\", StringComparison.Ordinal)) return "\\\\?\\UNC\\" + full.Substring(2);
      return "\\\\?\\" + full;
    }

    private FileObservation Observe(IntPtr handle) {
      ByHandleFileInformation information;
      if (!Native.GetFileInformationByHandle(handle, out information)) throw new InvalidOperationException("authorization-invalid");
      StringBuilder buffer = new StringBuilder(32768);
      uint length = Native.GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, 0u);
      if (length == 0 || length >= buffer.Capacity) throw new InvalidOperationException("authorization-invalid");
      return new FileObservation {
        FinalPath = buffer.ToString(),
        VolumeSerialNumber = information.VolumeSerialNumber,
        FileId = ((ulong)information.FileIndexHigh << 32) | information.FileIndexLow,
        IsDirectory = (information.Attributes & 0x10u) != 0,
        IsReparsePoint = (information.Attributes & 0x400u) != 0
      };
    }

    private void ApplyFault(FileObservation observation, string fault) {
      if (String.IsNullOrEmpty(fault)) return;
      if (fault == "FinalPath") observation.FinalPath = observation.FinalPath + ".drift";
      else if (fault == "ZeroVolume") observation.VolumeSerialNumber = 0;
      else if (fault == "ZeroFileId") observation.FileId = 0;
      else if (fault == "Volume") observation.VolumeSerialNumber = observation.VolumeSerialNumber == UInt32.MaxValue ? 1u : observation.VolumeSerialNumber + 1u;
      else if (fault == "Identity") observation.FileId = observation.FileId == UInt64.MaxValue ? 1u : observation.FileId + 1u;
      else if (fault == "Directory") observation.IsDirectory = !observation.IsDirectory;
      else if (fault == "Reparse") observation.IsReparsePoint = !observation.IsReparsePoint;
      else throw new InvalidOperationException("authorization-invalid");
    }

    private void ValidateAdmissible(FileObservation observation) {
      if (observation.IsDirectory || observation.IsReparsePoint || observation.VolumeSerialNumber == 0 || observation.FileId == 0 ||
          !String.Equals(observation.FinalPath, ExpectedFinalPath, StringComparison.OrdinalIgnoreCase)) {
        throw new InvalidOperationException("authorization-invalid");
      }
    }

    private void EnsureOpen() {
      if (disposed || stream == null || safeHandle == null || safeHandle.IsInvalid || safeHandle.IsClosed) throw new ObjectDisposedException("PinnedManifestFile");
    }

    public void Dispose() {
      if (disposed) return;
      disposed = true;
      Exception failure = null;
      for (int index = retainedFiles.Count - 1; index >= 0; index--) {
        try { retainedFiles[index].Dispose(); } catch (Exception error) { if (failure == null) failure = error; }
      }
      retainedFiles.Clear();
      FileStream currentStream = stream; stream = null;
      if (currentStream != null) { try { currentStream.Dispose(); } catch (Exception error) { if (failure == null) failure = error; } }
      SafeFileHandle currentHandle = safeHandle; safeHandle = null;
      if (currentHandle != null) { try { currentHandle.Dispose(); } catch (Exception error) { if (failure == null) failure = error; } }
      if (throwOnDispose && failure == null) failure = new InvalidOperationException("authorization-invalid");
      if (failure != null) throw new InvalidOperationException("authorization-invalid", failure);
    }
  }

  public enum ProbeDisposition { Present, Absent, Indeterminate }

  public static class EntryProbe {
    private static readonly IntPtr InvalidHandle = new IntPtr(-1);
    private const uint GenericRead = 0x80000000u;
    private const uint FileReadAttributes = 0x00000080u;
    private const uint ShareRead = 0x00000001u;
    private const uint ShareWrite = 0x00000002u;
    private const uint ShareDelete = 0x00000004u;
    private const uint OpenExisting = 3u;
    private const uint OpenReparsePoint = 0x00200000u;
    private const uint BackupSemantics = 0x02000000u;
    private const int ErrorFileNotFound = 2;
    private const int ErrorPathNotFound = 3;

    public static ProbeDisposition Probe(string path) {
      if (!PathRules.IsFullyQualifiedWindowsPath(path)) return ProbeDisposition.Indeterminate;
      IntPtr handle = Native.CreateFileW(path, GenericRead | FileReadAttributes, ShareRead | ShareWrite | ShareDelete,
        IntPtr.Zero, OpenExisting, OpenReparsePoint | BackupSemantics, IntPtr.Zero);
      if (handle == InvalidHandle) {
        int error = Marshal.GetLastWin32Error();
        return error == ErrorFileNotFound || error == ErrorPathNotFound
          ? ProbeDisposition.Absent : ProbeDisposition.Indeterminate;
      }
      Native.CloseHandle(handle);
      return ProbeDisposition.Present;
    }
  }

  public static class JobProbe {
    private const uint JobObjectQuery = 0x0004u;
    private const int ErrorFileNotFound = 2;

    public static ProbeDisposition Probe(string jobName) {
      if (String.IsNullOrEmpty(jobName) || jobName.IndexOf('\0') >= 0) return ProbeDisposition.Indeterminate;
      IntPtr handle = Native.OpenJobObject(JobObjectQuery, false, jobName);
      if (handle == IntPtr.Zero) {
        return Marshal.GetLastWin32Error() == ErrorFileNotFound
          ? ProbeDisposition.Absent : ProbeDisposition.Indeterminate;
      }
      Native.CloseHandle(handle);
      return ProbeDisposition.Present;
    }
  }

  public static class ProcessProbe {
    private const uint ProcessQueryLimitedInformation = 0x1000u;
    private const int ErrorInvalidParameter = 87;

    public static ProbeDisposition Probe(int processId, long creationFileTimeUtc) {
      return ProbeCore(processId, creationFileTimeUtc, 1L);
    }

    public static ProbeDisposition ProbeAtMillisecondPrecision(int processId, long creationFileTimeUtc) {
      return ProbeCore(processId, creationFileTimeUtc, TimeSpan.TicksPerMillisecond);
    }

    private static ProbeDisposition ProbeCore(int processId, long creationFileTimeUtc, long precisionTicks) {
      if (processId <= 0 || creationFileTimeUtc <= 0) return ProbeDisposition.Indeterminate;
      IntPtr handle = Native.OpenProcess(ProcessQueryLimitedInformation, false, unchecked((uint)processId));
      if (handle == IntPtr.Zero) {
        return Marshal.GetLastWin32Error() == ErrorInvalidParameter
          ? ProbeDisposition.Absent : ProbeDisposition.Indeterminate;
      }
      try {
        System.Runtime.InteropServices.ComTypes.FILETIME creation, exit, kernel, user;
        if (!Native.GetProcessTimes(handle, out creation, out exit, out kernel, out user)) return ProbeDisposition.Indeterminate;
        long observed = ((long)creation.dwHighDateTime << 32) | (uint)creation.dwLowDateTime;
        return observed / precisionTicks == creationFileTimeUtc / precisionTicks
          ? ProbeDisposition.Present : ProbeDisposition.Absent;
      } finally { Native.CloseHandle(handle); }
    }
  }

  public sealed class BoundaryGuard : IDisposable {
    private const uint GenericRead = 0x80000000u;
    private const uint GenericWrite = 0x40000000u;
    private const uint Delete = 0x00010000u;
    private const uint Synchronize = 0x00100000u;
    private const uint ReadControl = 0x00020000u;
    private const uint WriteDac = 0x00040000u;
    private const uint WriteOwner = 0x00080000u;
    private const uint FileReadAttributes = 0x00000080u;
    private const uint ShareRead = 0x00000001u;
    private const uint ShareWrite = 0x00000002u;
    private const uint ShareDelete = 0x00000004u;
    private const uint OpenExisting = 3u;
    private const uint OpenReparsePoint = 0x00200000u;
    private const uint BackupSemantics = 0x02000000u;
    private const uint FileCreate = 2u;
    private const uint FileWriteThrough = 0x00000002u;
    private const uint FileSynchronousIoNonAlert = 0x00000020u;
    private const uint FileDirectoryFile = 0x00000001u;
    private const uint FileNonDirectoryFile = 0x00000040u;
    private const uint FileOpenForBackupIntent = 0x00004000u;
    private const uint ObjectCaseInsensitive = 0x00000040u;
    private const uint FileAttributeNormal = 0x00000080u;
    private const uint FileAttributeDirectory = 0x00000010u;
    private const uint FileAttributeReparsePoint = 0x00000400u;
    private static readonly IntPtr InvalidHandle = new IntPtr(-1);

    private sealed class Component : IDisposable {
      internal SafeFileHandle Handle;
      internal FileObservation Observation;
      internal string ExpectedFinalPath;
      internal Component(SafeFileHandle handle, FileObservation observation, string expectedFinalPath) {
        Handle = handle; Observation = observation; ExpectedFinalPath = expectedFinalPath;
      }
      public void Dispose() { if (Handle != null) { Handle.Dispose(); Handle = null; } }
    }

    private readonly List<Component> components = new List<Component>();
    private readonly bool directory;
    private bool disposed;
    private string literalPath;

    public string CanonicalPath { get; private set; }
    public string StableIdentity { get; private set; }
    internal string LiteralPath { get { EnsureOpen(); return literalPath; } }
    internal bool IsDirectory { get { return directory; } }
    internal IntPtr LeafHandle { get { EnsureOpen(); return components[components.Count - 1].Handle.DangerousGetHandle(); } }

    private BoundaryGuard(string path, string expectedFinalPath, bool expectDirectory, uint leafAdditionalAccess,
        SafeFileHandle suppliedLeaf, bool deleteSuppliedLeafOnFailure, bool allowWriteShare, bool allowDeleteShare) {
      if (!PathRules.IsFullyQualifiedWindowsPath(path) || !PathRules.IsFullyQualifiedWindowsPath(expectedFinalPath))
        throw new InvalidOperationException("boundary-invalid");
      directory = expectDirectory;
      literalPath = CanonicalLiteral(path);
      string expectedLiteral = CanonicalLiteral(expectedFinalPath);
      SafeFileHandle createdLeaf = deleteSuppliedLeafOnFailure ? suppliedLeaf : null;
      bool createdLeafAdded = false;
      try {
        List<string> paths = Components(literalPath);
        for (int index = 0; index < paths.Count; index++) {
          bool leaf = index == paths.Count - 1;
          bool wantDirectory = leaf ? expectDirectory : true;
          uint access = ReadControl | (leaf ? leafAdditionalAccess : 0u) |
            (leaf && !expectDirectory ? GenericRead | FileReadAttributes : FileReadAttributes);
          SafeFileHandle safe;
          if (leaf && suppliedLeaf != null) {
            safe = suppliedLeaf;
            suppliedLeaf = null;
          } else {
            uint share = ShareRead | (allowWriteShare ? ShareWrite : 0u) | (allowDeleteShare ? ShareDelete : 0u);
            IntPtr raw = Native.CreateFileW(paths[index], access, share, IntPtr.Zero,
              OpenExisting, OpenReparsePoint | BackupSemantics, IntPtr.Zero);
            if (raw == InvalidHandle) throw new Win32Exception(Marshal.GetLastWin32Error());
            safe = new SafeFileHandle(raw, true);
          }
          try {
            FileObservation observation = Observe(safe.DangerousGetHandle());
            string expectedComponent = NormalizeFinalPath(paths[index]);
            ValidateObservation(observation, expectedComponent, wantDirectory);
            components.Add(new Component(safe, observation, expectedComponent));
            if (Object.ReferenceEquals(safe, createdLeaf)) createdLeafAdded = true;
            safe = null;
          } finally { if (safe != null && !Object.ReferenceEquals(safe, createdLeaf)) safe.Dispose(); }
        }
        Component final = components[components.Count - 1];
        string normalizedExpected = NormalizeFinalPath(expectedLiteral);
        if (!String.Equals(final.Observation.FinalPath, normalizedExpected, StringComparison.OrdinalIgnoreCase))
          throw new InvalidOperationException("boundary-invalid");
        CanonicalPath = final.Observation.FinalPath;
        StableIdentity = Identity(final.Observation);
      } catch (Exception error) {
        Exception cleanupFailure = null;
        if (createdLeaf != null && !createdLeaf.IsInvalid && !createdLeaf.IsClosed) {
          try { MarkDelete(createdLeaf.DangerousGetHandle()); }
          catch (Exception cleanupError) { cleanupFailure = cleanupError; }
        }
        if (suppliedLeaf != null) suppliedLeaf.Dispose();
        Dispose();
        if (!createdLeafAdded && createdLeaf != null && !createdLeaf.IsClosed) createdLeaf.Dispose();
        if (cleanupFailure != null) throw new InvalidOperationException("evidence-cleanup-invalid", cleanupFailure);
        throw new InvalidOperationException("boundary-invalid", error);
      }
    }

    public static BoundaryGuard OpenFile(string path, string expectedFinalPath) {
      return new BoundaryGuard(path, expectedFinalPath, false, 0u, null, false, false, false);
    }

    public static BoundaryGuard OpenDirectory(string path, string expectedFinalPath) {
      return new BoundaryGuard(path, expectedFinalPath, true, 0u, null, false, false, false);
    }

    public static BoundaryGuard OpenDirectoryForAudit(string path, string expectedFinalPath) {
      return new BoundaryGuard(path, expectedFinalPath, true, 0u, null, false, true, false);
    }

    internal static BoundaryGuard OpenDirectoryForEnvironment(string path, string expectedFinalPath) {
      return new BoundaryGuard(path, expectedFinalPath, true, GenericRead, null, false, true, false);
    }

    internal static BoundaryGuard OpenDirectoryForProtection(string path, string expectedFinalPath) {
      return new BoundaryGuard(path, expectedFinalPath, true, GenericWrite | WriteDac | WriteOwner, null, false, false, false);
    }

    internal static BoundaryGuard OpenFileForMutation(string path, string expectedFinalPath) {
      return new BoundaryGuard(path, expectedFinalPath, false, Delete | WriteDac | WriteOwner, null, false, false, false);
    }

    internal static BoundaryGuard OpenFileForRetainedVerification(string path, string expectedFinalPath) {
      return new BoundaryGuard(path, expectedFinalPath, false, 0u, null, false, true, true);
    }

    internal static BoundaryGuard CreateDirectoryRelative(BoundaryGuard parent, string leaf, string path, IntPtr securityDescriptor) {
      return CreateRelative(parent, leaf, path, true, securityDescriptor);
    }

    internal static BoundaryGuard CreateFileRelative(BoundaryGuard parent, string leaf, string path, IntPtr securityDescriptor) {
      return CreateRelative(parent, leaf, path, false, securityDescriptor);
    }

    private static BoundaryGuard CreateRelative(BoundaryGuard parent, string leaf, string path, bool createDirectory, IntPtr securityDescriptor) {
      if (parent == null || !parent.directory || !parent.Revalidate() || securityDescriptor == IntPtr.Zero ||
          !PathRules.IsFullyQualifiedWindowsPath(path) || String.IsNullOrEmpty(leaf) ||
          !String.Equals(CanonicalLiteral(path), Path.Combine(parent.literalPath, leaf), StringComparison.OrdinalIgnoreCase))
        throw new InvalidOperationException("boundary-invalid");
      IntPtr nameBuffer = IntPtr.Zero;
      IntPtr nameStructure = IntPtr.Zero;
      IntPtr raw = InvalidHandle;
      try {
        nameBuffer = Marshal.StringToHGlobalUni(leaf);
        UnicodeString name = new UnicodeString {
          Length = checked((ushort)(leaf.Length * 2)), MaximumLength = checked((ushort)((leaf.Length + 1) * 2)), Buffer = nameBuffer
        };
        nameStructure = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UnicodeString)));
        Marshal.StructureToPtr(name, nameStructure, false);
        ObjectAttributes attributes = new ObjectAttributes {
          Length = unchecked((uint)Marshal.SizeOf(typeof(ObjectAttributes))), RootDirectory = parent.LeafHandle,
          ObjectName = nameStructure, Attributes = ObjectCaseInsensitive, SecurityDescriptor = securityDescriptor,
          SecurityQualityOfService = IntPtr.Zero
        };
        uint access = GenericRead | GenericWrite | Delete | Synchronize | ReadControl | WriteDac | WriteOwner | FileReadAttributes;
        uint options = FileWriteThrough | FileSynchronousIoNonAlert | FileOpenForBackupIntent | OpenReparsePoint |
          (createDirectory ? FileDirectoryFile : FileNonDirectoryFile);
        IoStatusBlock ioStatus;
        int status = Native.NtCreateFile(out raw, access, ref attributes, out ioStatus, IntPtr.Zero,
          createDirectory ? FileAttributeDirectory : FileAttributeNormal,
          createDirectory ? ShareRead | ShareWrite : ShareRead, FileCreate, options, IntPtr.Zero, 0u);
        if (status == unchecked((int)0xc0000035)) throw new InvalidOperationException("evidence-collision");
        if (status != 0 || raw == InvalidHandle) throw new InvalidOperationException("native-create-status:" + status.ToString("x8"));
        SafeFileHandle created = new SafeFileHandle(raw, true);
        raw = IntPtr.Zero;
        return new BoundaryGuard(path, path, createDirectory, 0u, created, true, false, false);
      } finally {
        if (raw != IntPtr.Zero && raw != InvalidHandle) Native.CloseHandle(raw);
        if (nameStructure != IntPtr.Zero) Marshal.FreeHGlobal(nameStructure);
        if (nameBuffer != IntPtr.Zero) Marshal.FreeHGlobal(nameBuffer);
      }
    }

    internal void WriteAndFlush(byte[] bytes) {
      EnsureOpen();
      if (directory || bytes == null) throw new InvalidOperationException("boundary-invalid");
      long position;
      if (!Native.SetFilePointerEx(LeafHandle, 0, out position, 0u) || position != 0) throw new InvalidOperationException("boundary-invalid");
      int offset = 0;
      while (offset < bytes.Length) {
        int count = Math.Min(81920, bytes.Length - offset);
        byte[] chunk = new byte[count];
        Buffer.BlockCopy(bytes, offset, chunk, 0, count);
        uint written;
        if (!Native.WriteFile(LeafHandle, chunk, unchecked((uint)count), out written, IntPtr.Zero) || written != count)
          throw new Win32Exception(Marshal.GetLastWin32Error());
        offset += checked((int)written);
      }
      FlushDurable();
    }

    internal void FlushDurable() {
      EnsureOpen();
      if (!Revalidate() || !Native.FlushFileBuffers(LeafHandle) || !Revalidate())
        throw new InvalidOperationException("evidence-durability-invalid");
    }

    internal void RebindLeaf(string expectedFinalPath) {
      EnsureOpen();
      string expected = NormalizeFinalPath(expectedFinalPath);
      Component leaf = components[components.Count - 1];
      FileObservation observed = Observe(leaf.Handle.DangerousGetHandle());
      if (!Admissible(observed, expected, directory) || observed.VolumeSerialNumber != leaf.Observation.VolumeSerialNumber ||
          observed.FileId != leaf.Observation.FileId || observed.IsDirectory != leaf.Observation.IsDirectory ||
          observed.IsReparsePoint != leaf.Observation.IsReparsePoint) throw new InvalidOperationException("boundary-invalid");
      leaf.ExpectedFinalPath = expected;
      leaf.Observation = observed;
      literalPath = CanonicalLiteral(expectedFinalPath);
      CanonicalPath = observed.FinalPath;
    }

    private static void MarkDelete(IntPtr handle) {
      IntPtr information = Marshal.AllocHGlobal(4);
      try {
        Marshal.WriteInt32(information, 1);
        if (!Native.SetFileInformationByHandle(handle, 4u, information, 4u))
          throw new Win32Exception(Marshal.GetLastWin32Error());
      } finally { Marshal.FreeHGlobal(information); }
    }

    public byte[] ReadAllBytes(long maximumBytes) {
      EnsureOpen();
      if (directory || maximumBytes < 1 || maximumBytes > Int32.MaxValue) throw new InvalidOperationException("boundary-invalid");
      if (!Revalidate()) throw new InvalidOperationException("boundary-invalid");
      long position;
      if (!Native.SetFilePointerEx(LeafHandle, 0, out position, 0u) || position != 0) throw new InvalidOperationException("boundary-invalid");
      MemoryStream output = new MemoryStream();
      byte[] buffer = new byte[81920];
      try {
        while (true) {
          long remaining = maximumBytes - output.Length + 1;
          uint request = (uint)Math.Min((long)buffer.Length, remaining);
          uint read;
          if (!Native.ReadFile(LeafHandle, buffer, request, out read, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
          if (read == 0) break;
          if (output.Length + read > maximumBytes) throw new InvalidOperationException("boundary-invalid");
          output.Write(buffer, 0, checked((int)read));
        }
        if (!Revalidate()) throw new InvalidOperationException("boundary-invalid");
        return output.ToArray();
      } finally { output.Dispose(); }
    }

    public bool Revalidate() {
      EnsureOpen();
      for (int index = 0; index < components.Count; index++) {
        Component component = components[index];
        FileObservation observed;
        try { observed = Observe(component.Handle.DangerousGetHandle()); }
        catch { return false; }
        FileObservation prior = component.Observation;
        bool expectedDirectory = index < components.Count - 1 || directory;
        if (!Admissible(observed, component.ExpectedFinalPath, expectedDirectory) ||
            observed.VolumeSerialNumber != prior.VolumeSerialNumber || observed.FileId != prior.FileId ||
            observed.IsDirectory != prior.IsDirectory || observed.IsReparsePoint != prior.IsReparsePoint) return false;
      }
      return true;
    }

    private static string CanonicalLiteral(string path) {
      string full = Path.GetFullPath(path.Replace('/', '\\'));
      string root = Path.GetPathRoot(full);
      return String.Equals(full, root, StringComparison.OrdinalIgnoreCase) ? full : full.TrimEnd('\\');
    }

    private static List<string> Components(string path) {
      List<string> result = new List<string>();
      string root = Path.GetPathRoot(path);
      if (String.IsNullOrEmpty(root)) throw new InvalidOperationException("boundary-invalid");
      string current = root;
      result.Add(current);
      string remainder = path.Substring(root.Length);
      foreach (string leaf in remainder.Split(new char[] { '\\' }, StringSplitOptions.RemoveEmptyEntries)) {
        current = Path.Combine(current, leaf);
        result.Add(current);
      }
      return result;
    }

    internal static string NormalizeFinalPath(string path) {
      string full = CanonicalLiteral(path);
      if (full.StartsWith("\\\\?\\", StringComparison.Ordinal)) return full;
      if (full.StartsWith("\\\\", StringComparison.Ordinal)) return "\\\\?\\UNC\\" + full.Substring(2);
      return "\\\\?\\" + full;
    }

    private static FileObservation Observe(IntPtr handle) {
      ByHandleFileInformation information;
      if (!Native.GetFileInformationByHandle(handle, out information)) throw new Win32Exception(Marshal.GetLastWin32Error());
      StringBuilder path = new StringBuilder(32768);
      uint length = Native.GetFinalPathNameByHandleW(handle, path, (uint)path.Capacity, 0u);
      if (length == 0 || length >= path.Capacity) throw new Win32Exception(Marshal.GetLastWin32Error());
      return new FileObservation {
        FinalPath = path.ToString(), VolumeSerialNumber = information.VolumeSerialNumber,
        FileId = ((ulong)information.FileIndexHigh << 32) | information.FileIndexLow,
        IsDirectory = (information.Attributes & FileAttributeDirectory) != 0,
        IsReparsePoint = (information.Attributes & FileAttributeReparsePoint) != 0
      };
    }

    private static string Identity(FileObservation observation) {
      return observation.VolumeSerialNumber.ToString("x8") + ":" + observation.FileId.ToString("x16");
    }

    private static bool Admissible(FileObservation observation, string expectedFinalPath, bool expectDirectory) {
      return observation != null && observation.VolumeSerialNumber != 0 && observation.FileId != 0 &&
        observation.IsDirectory == expectDirectory && !observation.IsReparsePoint &&
        String.Equals(observation.FinalPath, expectedFinalPath, StringComparison.OrdinalIgnoreCase);
    }

    private static void ValidateObservation(FileObservation observation, string expectedFinalPath, bool expectDirectory) {
      if (!Admissible(observation, expectedFinalPath, expectDirectory)) throw new InvalidOperationException("boundary-invalid");
    }

    private void EnsureOpen() {
      if (disposed || components.Count == 0) throw new ObjectDisposedException("BoundaryGuard");
    }

    public void Dispose() {
      if (disposed) return;
      disposed = true;
      for (int index = components.Count - 1; index >= 0; index--) {
        try { components[index].Dispose(); } catch { }
      }
      components.Clear();
    }
  }

  public static class ProtectedEvidenceStore {
    private const uint OwnerSecurityInformation = 0x00000001u;
    private const uint DaclSecurityInformation = 0x00000004u;
    private const uint ProtectedDaclSecurityInformation = 0x80000000u;
    private const uint SeFileObject = 1u;
    private const int FileRenameInformation = 10;
    private const uint FileDispositionInfo = 4u;
    public static BoundaryGuard CreateExclusiveRoot(string parentPath, string leaf) {
      ValidateLeaf(leaf);
      BoundaryGuard parent = BoundaryGuard.OpenDirectoryForProtection(parentPath, parentPath);
      string rootPath = DirectChild(parent, leaf);
      IntPtr descriptor = IntPtr.Zero;
      BoundaryGuard root = null;
      try {
        ProbeDisposition rootDisposition = EntryProbe.Probe(rootPath);
        if (rootDisposition != ProbeDisposition.Absent)
          throw new InvalidOperationException(rootDisposition == ProbeDisposition.Present ? "evidence-collision" : "evidence-indeterminate");
        if (!ValidateProtection(parent)) {
          if (!parent.Revalidate()) throw new InvalidOperationException("evidence-parent-invalid");
          ApplyProtection(parent.LeafHandle, true);
          if (!parent.Revalidate() || !ValidateProtection(parent)) throw new InvalidOperationException("evidence-protection-invalid");
        }
        parent.FlushDurable();
        descriptor = BuildDescriptor(true);
        root = BoundaryGuard.CreateDirectoryRelative(parent, leaf, rootPath, descriptor);
        if (!ValidateProtection(root)) throw new InvalidOperationException("evidence-protection-invalid");
        ApplyProtection(root.LeafHandle, true);
        if (!root.Revalidate() || !ValidateProtection(root)) throw new InvalidOperationException("evidence-protection-invalid");
        root.FlushDurable();
        parent.FlushDurable();
        if (!parent.Revalidate() || !root.Revalidate() || !ValidateProtection(parent) || !ValidateProtection(root))
          throw new InvalidOperationException("evidence-durability-invalid");
        BoundaryGuard result = root;
        root = null;
        return result;
      } finally {
        if (descriptor != IntPtr.Zero) Native.LocalFree(descriptor);
        if (root != null) root.Dispose();
        parent.Dispose();
      }
    }

    public static BoundaryGuard WriteAtomicNew(BoundaryGuard root, string leaf, byte[] bytes) {
      return WriteAtomicNew(root, leaf, bytes, null);
    }

    public static BoundaryGuard WriteAtomicNew(BoundaryGuard root, string leaf, byte[] bytes, Action<BoundaryGuard> retainAfterPromotion) {
      RequireProtectedRoot(root);
      ValidateLeaf(leaf);
      if (bytes == null) throw new ArgumentNullException("bytes");
      string destination = DirectChild(root, leaf);
      ProbeDisposition disposition = EntryProbe.Probe(destination);
      if (disposition != ProbeDisposition.Absent) throw new InvalidOperationException(disposition == ProbeDisposition.Present ? "evidence-collision" : "evidence-indeterminate");
      string temporary = DirectChild(root, "." + leaf + "." + Guid.NewGuid().ToString("N") + ".tmp");
      string temporaryLeaf = Path.GetFileName(temporary);
      bool promoted = false;
      bool retentionTransferred = false;
      BoundaryGuard temporaryGuard = null;
      string temporaryIdentity = null;
      try {
        temporaryGuard = WriteProtectedTemporary(root, temporaryLeaf, temporary, bytes);
        temporaryIdentity = temporaryGuard.StableIdentity;
        ProbeDisposition finalDisposition = EntryProbe.Probe(destination);
        if (finalDisposition != ProbeDisposition.Absent)
          throw new InvalidOperationException(finalDisposition == ProbeDisposition.Present ? "evidence-collision" : "evidence-indeterminate");
        PromoteBoundIdentity(root, temporaryGuard, temporary, leaf);
        promoted = true;
        if (retainAfterPromotion != null) {
          retainAfterPromotion(temporaryGuard);
          retentionTransferred = true;
        }
        temporaryGuard.RebindLeaf(destination);
        if (!temporaryGuard.Revalidate() || !ValidateProtection(temporaryGuard) ||
            !String.Equals(temporaryGuard.StableIdentity, temporaryIdentity, StringComparison.Ordinal))
          throw new InvalidOperationException("evidence-write-invalid");
        byte[] actual = temporaryGuard.ReadAllBytes(Math.Max(1, bytes.LongLength));
        if (!FixedBytes(actual, bytes)) throw new InvalidOperationException("evidence-write-invalid");
        temporaryGuard.FlushDurable();
        root.FlushDurable();
        if (!root.Revalidate() || !temporaryGuard.Revalidate() || !ValidateProtection(root) || !ValidateProtection(temporaryGuard))
          throw new InvalidOperationException("evidence-durability-invalid");
        BoundaryGuard verification = BoundaryGuard.OpenFileForRetainedVerification(destination, destination);
        try {
          byte[] reopened = verification.ReadAllBytes(Math.Max(1, bytes.LongLength));
          if (!ValidateProtection(verification) || !FixedBytes(reopened, bytes) ||
              !String.Equals(verification.StableIdentity, temporaryIdentity, StringComparison.Ordinal))
            throw new InvalidOperationException("evidence-write-invalid");
        } finally { verification.Dispose(); }
        BoundaryGuard result = temporaryGuard;
        temporaryGuard = null;
        return result;
      } finally {
        if (!promoted && temporaryIdentity != null) CleanupRetainedTemporary(root, temporaryLeaf, temporaryIdentity, temporaryGuard);
        else if (temporaryGuard != null && !retentionTransferred) temporaryGuard.Dispose();
      }
    }

    public static BoundaryGuard OpenValidated(BoundaryGuard root, string leaf, long maximumBytes) {
      RequireProtectedRoot(root);
      ValidateLeaf(leaf);
      string path = DirectChild(root, leaf);
      BoundaryGuard guard = BoundaryGuard.OpenFile(path, path);
      try {
        if (!ValidateProtection(guard)) throw new InvalidOperationException("evidence-protection-invalid");
        guard.ReadAllBytes(maximumBytes);
        return guard;
      } catch { guard.Dispose(); throw; }
    }

    public static bool ValidateProtection(BoundaryGuard guard) {
      if (guard == null) return false;
      try {
        if (!guard.Revalidate()) return false;
        IntPtr owner, group, dacl, sacl, descriptor;
        uint result = Native.GetSecurityInfo(guard.LeafHandle, SeFileObject,
          OwnerSecurityInformation | DaclSecurityInformation, out owner, out group, out dacl, out sacl, out descriptor);
        if (result != 0 || descriptor == IntPtr.Zero) return false;
        try {
          uint length = Native.GetSecurityDescriptorLength(descriptor);
          if (length == 0 || length > 65536) return false;
          byte[] bytes = new byte[length];
          Marshal.Copy(descriptor, bytes, 0, checked((int)length));
          RawSecurityDescriptor raw = new RawSecurityDescriptor(bytes, 0);
          return IsClosedDescriptor(raw, guard.IsDirectory);
        } finally { Native.LocalFree(descriptor); }
      } catch { return false; }
    }

    private static void RequireProtectedRoot(BoundaryGuard root) {
      if (root == null || !root.IsDirectory || !ValidateProtection(root)) throw new InvalidOperationException("evidence-root-invalid");
    }

    private static BoundaryGuard WriteProtectedTemporary(BoundaryGuard root, string leaf, string path, byte[] bytes) {
      IntPtr descriptor = IntPtr.Zero;
      BoundaryGuard guard = null;
      try {
        descriptor = BuildDescriptor(false);
        guard = BoundaryGuard.CreateFileRelative(root, leaf, path, descriptor);
        guard.WriteAndFlush(bytes);
        if (!guard.Revalidate()) throw new InvalidOperationException("evidence-write-invalid");
        ApplyProtection(guard.LeafHandle, false);
        if (!guard.Revalidate() || !ValidateProtection(guard)) throw new InvalidOperationException("evidence-protection-invalid");
        guard.FlushDurable();
        byte[] actual = guard.ReadAllBytes(Math.Max(1, bytes.LongLength));
        if (!FixedBytes(actual, bytes)) throw new InvalidOperationException("evidence-write-invalid");
        return guard;
      } catch {
        if (guard != null) {
          try { DeleteBoundIdentity(guard); }
          finally { guard.Dispose(); }
        }
        if (EntryProbe.Probe(path) != ProbeDisposition.Absent) throw new InvalidOperationException("evidence-cleanup-invalid");
        throw;
      } finally { if (descriptor != IntPtr.Zero) Native.LocalFree(descriptor); }
    }

    private static void PromoteBoundIdentity(BoundaryGuard root, BoundaryGuard source, string sourcePath, string destinationLeaf) {
      RequireProtectedRoot(root);
      ValidateLeaf(destinationLeaf);
      if (source == null || !source.Revalidate() ||
          !String.Equals(source.CanonicalPath, BoundaryGuard.NormalizeFinalPath(sourcePath), StringComparison.OrdinalIgnoreCase))
        throw new InvalidOperationException("evidence-source-invalid");
      byte[] name = Encoding.Unicode.GetBytes(destinationLeaf);
      int rootOffset = IntPtr.Size == 8 ? 8 : 4;
      int lengthOffset = rootOffset + IntPtr.Size;
      int nameOffset = lengthOffset + 4;
      IntPtr information = Marshal.AllocHGlobal(nameOffset + name.Length);
      try {
        for (int index = 0; index < nameOffset + name.Length; index++) Marshal.WriteByte(information, index, 0);
        Marshal.WriteByte(information, 0, 0);
        Marshal.WriteIntPtr(information, rootOffset, root.LeafHandle);
        Marshal.WriteInt32(information, lengthOffset, name.Length);
        Marshal.Copy(name, 0, new IntPtr(information.ToInt64() + nameOffset), name.Length);
        IoStatusBlock ioStatus;
        int status = Native.NtSetInformationFile(source.LeafHandle, out ioStatus, information,
          unchecked((uint)(nameOffset + name.Length)), FileRenameInformation);
        if (status != 0) {
          if (status == unchecked((int)0xc0000035)) throw new InvalidOperationException("evidence-collision");
          throw new InvalidOperationException("evidence-promotion-status:" + status.ToString("x8"));
        }
      } finally { Marshal.FreeHGlobal(information); }
    }

    private static void DeleteBoundIdentity(BoundaryGuard guard) {
      if (guard == null || !guard.Revalidate()) throw new InvalidOperationException("evidence-delete-invalid");
      IntPtr information = Marshal.AllocHGlobal(4);
      try {
        Marshal.WriteInt32(information, 1);
        if (!Native.SetFileInformationByHandle(guard.LeafHandle, FileDispositionInfo, information, 4u))
          throw new Win32Exception(Marshal.GetLastWin32Error());
      } finally { Marshal.FreeHGlobal(information); }
    }

    private static void CleanupRetainedTemporary(BoundaryGuard root, string leaf, string expectedIdentity, BoundaryGuard retained) {
      if (retained == null || !String.Equals(retained.StableIdentity, expectedIdentity, StringComparison.Ordinal))
        throw new InvalidOperationException("evidence-cleanup-identity-invalid");
      try { DeleteBoundIdentity(retained); }
      finally { retained.Dispose(); }
      if (EntryProbe.Probe(DirectChild(root, leaf)) != ProbeDisposition.Absent)
        throw new InvalidOperationException("evidence-cleanup-invalid");
    }

    private static void CleanupTemporary(BoundaryGuard root, string leaf, string expectedIdentity) {
      RequireProtectedRoot(root);
      ValidateLeaf(leaf);
      string path = DirectChild(root, leaf);
      BoundaryGuard guard = BoundaryGuard.OpenFileForMutation(path, path);
      try {
        if (!String.Equals(guard.StableIdentity, expectedIdentity, StringComparison.Ordinal) || !ValidateProtection(guard))
          throw new InvalidOperationException("evidence-cleanup-identity-invalid");
        DeleteBoundIdentity(guard);
      } finally { guard.Dispose(); }
      if (EntryProbe.Probe(path) != ProbeDisposition.Absent) throw new InvalidOperationException("evidence-cleanup-invalid");
    }

    private static string DirectChild(BoundaryGuard root, string leaf) {
      ValidateLeaf(leaf);
      string parent = root.LiteralPath.TrimEnd('\\');
      string child = Path.GetFullPath(Path.Combine(parent, leaf));
      if (!String.Equals(Path.GetDirectoryName(child), parent, StringComparison.OrdinalIgnoreCase) ||
          !String.Equals(Path.GetFileName(child), leaf, StringComparison.Ordinal)) throw new InvalidOperationException("evidence-child-invalid");
      return child;
    }

    private static void ValidateLeaf(string leaf) {
      if (String.IsNullOrEmpty(leaf) || leaf == "." || leaf == ".." || leaf.EndsWith(".", StringComparison.Ordinal) ||
          leaf.EndsWith(" ", StringComparison.Ordinal) || leaf.IndexOf('\\') >= 0 || leaf.IndexOf('/') >= 0 || leaf.IndexOf(':') >= 0)
        throw new InvalidOperationException("evidence-child-invalid");
      foreach (char value in leaf) if (value < 32) throw new InvalidOperationException("evidence-child-invalid");
    }

    private static IntPtr BuildDescriptor(bool directory) {
      SecurityIdentifier current;
      using (WindowsIdentity identity = WindowsIdentity.GetCurrent()) {
        current = identity.User;
        if (current == null) throw new InvalidOperationException("evidence-protection-invalid");
      }
      string inherit = directory ? "OICI" : "";
      string sddl = "O:" + current.Value + "D:P(A;" + inherit + ";FA;;;" + current.Value + ")" +
        "(A;" + inherit + ";FA;;;SY)(A;" + inherit + ";FA;;;BA)";
      IntPtr descriptor;
      uint size;
      if (!Native.ConvertStringSecurityDescriptor(sddl, 1u, out descriptor, out size) || descriptor == IntPtr.Zero)
        throw new Win32Exception(Marshal.GetLastWin32Error());
      return descriptor;
    }

    private static void ApplyProtection(IntPtr handle, bool directory) {
      IntPtr descriptor = BuildDescriptor(directory);
      try {
        IntPtr owner, dacl;
        bool defaulted, present;
        if (!Native.GetSecurityDescriptorOwner(descriptor, out owner, out defaulted) || owner == IntPtr.Zero ||
            !Native.GetSecurityDescriptorDacl(descriptor, out present, out dacl, out defaulted) || !present || dacl == IntPtr.Zero)
          throw new InvalidOperationException("evidence-protection-invalid");
        uint result = Native.SetSecurityInfo(handle, SeFileObject,
          OwnerSecurityInformation | DaclSecurityInformation | ProtectedDaclSecurityInformation,
          owner, IntPtr.Zero, dacl, IntPtr.Zero);
        if (result != 0) throw new Win32Exception(unchecked((int)result));
      } finally { Native.LocalFree(descriptor); }
    }

    private static bool IsClosedDescriptor(RawSecurityDescriptor descriptor, bool directory) {
      SecurityIdentifier current;
      using (WindowsIdentity identity = WindowsIdentity.GetCurrent()) { current = identity.User; }
      if (current == null || descriptor.Owner == null || !descriptor.Owner.Equals(current) ||
          (descriptor.ControlFlags & ControlFlags.DiscretionaryAclProtected) == 0 || descriptor.DiscretionaryAcl == null ||
          descriptor.DiscretionaryAcl.Count != 3) return false;
      HashSet<string> expected = new HashSet<string>(StringComparer.Ordinal) {
        current.Value, new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null).Value,
        new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null).Value
      };
      AceFlags expectedFlags = directory ? AceFlags.ObjectInherit | AceFlags.ContainerInherit : AceFlags.None;
      foreach (GenericAce generic in descriptor.DiscretionaryAcl) {
        CommonAce ace = generic as CommonAce;
        if (ace == null || ace.AceQualifier != AceQualifier.AccessAllowed || ace.IsInherited ||
            ace.AccessMask != (int)FileSystemRights.FullControl || ace.AceFlags != expectedFlags || !expected.Remove(ace.SecurityIdentifier.Value)) return false;
      }
      return expected.Count == 0;
    }

    private static bool FixedBytes(byte[] left, byte[] right) {
      if (left == null || right == null || left.Length != right.Length) return false;
      int difference = 0;
      for (int index = 0; index < left.Length; index++) difference |= left[index] ^ right[index];
      return difference == 0;
    }

  }

  public enum ProcessRole { GitObservation, Controller }

  public sealed class ControllerLaunchGate {
    private readonly bool durableConsumptionValidated;
    private int used;
    internal ControllerLaunchGate(bool validated) { durableConsumptionValidated = validated; }
    internal bool TryConsume() {
      return durableConsumptionValidated && Interlocked.Exchange(ref used, 1) == 0;
    }
  }

  public sealed class NativeProcessSupervisor {
    public int processId { get; private set; }
    public string startTimeUtc { get; private set; }
    internal Process Process;
    internal Task<NativeStreamCapture> StdoutTask;
    internal Task<NativeStreamCapture> StderrTask;
    internal bool ReceiveAttempted;
    internal bool SettlementComplete;
    internal bool CaptureComplete;
    internal bool WaitForExitFault;
    internal int ExitCode;
    internal string StartedObservedAtUtc;
    internal string CaptureCompletedAtUtc;
    internal string ExitedAtUtc;
    internal NativeStreamCapture StdoutCapture;
    internal NativeStreamCapture StderrCapture;
    internal BoundaryGuard EnvironmentGuard;
    internal NativeProcessSupervisor(Process process, int id, string startTime,
        Task<NativeStreamCapture> stdoutTask, Task<NativeStreamCapture> stderrTask, bool waitForExitFault) {
      Process = process; processId = id; startTimeUtc = startTime;
      StdoutTask = stdoutTask; StderrTask = stderrTask;
      WaitForExitFault = waitForExitFault;
      StartedObservedAtUtc = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fff'Z'", System.Globalization.CultureInfo.InvariantCulture);
    }
  }

  internal sealed class NativeStreamCapture {
    internal byte[] Retained;
    internal long Count;
    internal string Sha256;
    internal bool Overflow;
    internal bool Eof;
    internal bool DrainCompleted;
  }

  public sealed class NativeProcessBindings {
    internal ProcessRole Role;
    internal string ExecutablePath;
    internal string WorkingDirectory;
    internal string ControllerPath;
    internal string PnpmPath;
    internal string ExpectedCommit;
    internal string PnpmSha256;
    internal NativeProcessBindings(ProcessRole role, string executablePath, string workingDirectory,
        string controllerPath, string pnpmPath, string expectedCommit, string pnpmSha256) {
      Role = role; ExecutablePath = executablePath; WorkingDirectory = workingDirectory;
      ControllerPath = controllerPath; PnpmPath = pnpmPath;
      ExpectedCommit = expectedCommit; PnpmSha256 = pnpmSha256;
    }
  }

  public sealed class NativeProcessLaunchResult {
    public bool processCreated { get; private set; }
    public bool nonCreationProven { get; private set; }
    public NativeProcessSupervisor supervisor { get; private set; }
    public bool supervisorIdentityValid { get; private set; }
    public bool drainsInitialized { get; private set; }
    public string setupCategory { get; private set; }
    internal NativeProcessLaunchResult(bool created, bool nonCreation, NativeProcessSupervisor processSupervisor,
        bool identityValid, bool drainsReady, string category) {
      processCreated = created; nonCreationProven = nonCreation; supervisor = processSupervisor;
      supervisorIdentityValid = identityValid; drainsInitialized = drainsReady; setupCategory = category;
    }
  }

  public sealed class NativeProcessCaptureResult {
    public byte[] stdout { get; private set; }
    public long stdoutBytes { get; private set; }
    public string stdoutSha256 { get; private set; }
    public long stderrBytes { get; private set; }
    public string stderrSha256 { get; private set; }
    public bool stdoutOverflow { get; private set; }
    public bool stderrOverflow { get; private set; }
    internal NativeProcessCaptureResult(NativeStreamCapture stdoutCapture, NativeStreamCapture stderrCapture) {
      stdout = stdoutCapture.Retained; stdoutBytes = stdoutCapture.Count; stdoutSha256 = stdoutCapture.Sha256;
      stderrBytes = stderrCapture.Count; stderrSha256 = stderrCapture.Sha256;
      stdoutOverflow = stdoutCapture.Overflow; stderrOverflow = stderrCapture.Overflow;
    }
  }

  public static class NativeProcessDispatcher {
    private const int MaximumCaptureBytes = 1048576;
    // Uncertain children retain their environment identity until host exit. Only proven
    // non-creation or exact settlement releases a lease; no extra wait or recovery occurs.
    private static readonly List<BoundaryGuard> EnvironmentGuards = new List<BoundaryGuard>();

    private static void ReleaseEnvironmentGuard(BoundaryGuard guard) {
      if (guard == null) return;
      lock (EnvironmentGuards) { EnvironmentGuards.Remove(guard); }
      guard.Dispose();
    }
    private static readonly string[] CommonEnvironmentNames = new string[] {
      "SystemRoot", "WINDIR", "TEMP", "TMP", "ComSpec", "NoDefaultCurrentDirectoryInExePath"
    };

    public static ControllerLaunchGate CreateControllerLaunchGate(bool durableConsumptionValidated) {
      if (!durableConsumptionValidated) throw new InvalidOperationException("consumption-gate-invalid");
      return new ControllerLaunchGate(true);
    }

    public static NativeProcessBindings CreateControllerBindings(string executablePath, string workingDirectory,
        string controllerPath, string pnpmPath, string expectedCommit, string pnpmSha256) {
      if (!PathRules.IsFullyQualifiedWindowsPath(executablePath) || !PathRules.IsFullyQualifiedWindowsPath(workingDirectory) ||
          !PathRules.IsFullyQualifiedWindowsPath(controllerPath) || !PathRules.IsFullyQualifiedWindowsPath(pnpmPath) ||
          !IsLowerHex(expectedCommit, 40) || !IsLowerHex(pnpmSha256, 64))
        throw new InvalidOperationException("process-bindings-invalid");
      return new NativeProcessBindings(ProcessRole.Controller, executablePath, workingDirectory, controllerPath, pnpmPath,
        expectedCommit, pnpmSha256);
    }

    public static NativeProcessBindings CreateGitBindings(string executablePath, string workingDirectory) {
      if (!PathRules.IsFullyQualifiedWindowsPath(executablePath) || !PathRules.IsFullyQualifiedWindowsPath(workingDirectory))
        throw new InvalidOperationException("process-bindings-invalid");
      return new NativeProcessBindings(ProcessRole.GitObservation, executablePath, workingDirectory, null, null, null, null);
    }

    public static NativeProcessLaunchResult Run(ProcessRole role, ProcessStartInfo startInfo,
        NativeProcessBindings bindings, ControllerLaunchGate controllerGate, string setupFault) {
      ValidateStartInfo(role, startInfo, bindings);
      if (role == ProcessRole.Controller) {
        if (controllerGate == null || !controllerGate.TryConsume()) throw new InvalidOperationException("controller-cardinality-invalid");
      } else if (controllerGate != null) throw new InvalidOperationException("git-role-invalid");
      if (!String.IsNullOrEmpty(setupFault) && setupFault != "supervisor-identity" &&
          setupFault != "drain-initialization" && setupFault != "identity-and-drain" &&
          setupFault != "cancellation-after-creation" && setupFault != "pre-creation-failure" &&
          setupFault != "process-start-exception" && setupFault != "partial-drain-initialization" &&
          setupFault != "wait-for-exit" && setupFault != "stderr-mid-drain-failure" &&
          setupFault != "stderr-read-failure")
        throw new InvalidOperationException("process-setup-fault-invalid");

      // ValidateEnvironment already binds both TEMP and TMP to this exact fixed path.
      // OpenDirectory pins every ordinary ancestor and the leaf before the first Git
      // or controller process can use it, independently of outer boundary ordering.
      BoundaryGuard environmentGuard = BoundaryGuard.OpenDirectoryForEnvironment(startInfo.EnvironmentVariables["TEMP"], startInfo.EnvironmentVariables["TEMP"]);
      lock (EnvironmentGuards) { EnvironmentGuards.Add(environmentGuard); }
      bool created = false;
      bool nonCreationProven = true;
      try {
        if (setupFault == "pre-creation-failure")
          return new NativeProcessLaunchResult(false, true, null, false, false, "launch-failed");

        Process process = new Process();
        process.StartInfo = startInfo;
        if (setupFault == "process-start-exception")
          process.StartInfo.FileName = Path.Combine(Path.GetTempPath(), "intentarc-missing-" + Guid.NewGuid().ToString("N") + ".exe");
        try {
          nonCreationProven = false;
          created = process.Start();
        } catch {
          process.Dispose();
          throw new InvalidOperationException("process-launch-uncertain");
        }
        if (!created) {
          nonCreationProven = true;
          process.Dispose();
          return new NativeProcessLaunchResult(false, true, null, false, false, "launch-failed");
        }

        int processId;
        string startTimeUtc;
        bool identityValid = true;
        try {
          processId = process.Id;
          startTimeUtc = process.StartTime.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fff'Z'", System.Globalization.CultureInfo.InvariantCulture);
          if (processId <= 0 || setupFault == "supervisor-identity" || setupFault == "identity-and-drain") identityValid = false;
        } catch {
          processId = Int32.MaxValue;
          startTimeUtc = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fff'Z'", System.Globalization.CultureInfo.InvariantCulture);
          identityValid = false;
        }

        Task<NativeStreamCapture> stdoutTask = null;
        Task<NativeStreamCapture> stderrTask = null;
        bool drainsReady = true;
        try {
          stdoutTask = DrainAsync(process.StandardOutput.BaseStream, true, false, false);
          if (setupFault == "partial-drain-initialization") throw new InvalidOperationException("capture-initialization-invalid");
          stderrTask = DrainAsync(process.StandardError.BaseStream, false, setupFault == "stderr-mid-drain-failure",
            setupFault == "stderr-read-failure");
          if (setupFault == "drain-initialization" || setupFault == "identity-and-drain" || setupFault == "cancellation-after-creation") drainsReady = false;
        } catch { drainsReady = false; }
        NativeProcessSupervisor supervisor = new NativeProcessSupervisor(process, processId, startTimeUtc, stdoutTask, stderrTask,
          setupFault == "wait-for-exit");
        supervisor.EnvironmentGuard = environmentGuard;
        string category = !identityValid ? "supervisor-identity-invalid" : !drainsReady ? "drain-initialization-invalid" : "none";
        return new NativeProcessLaunchResult(true, false, supervisor, identityValid, drainsReady, category);
      } finally {
        if (nonCreationProven) ReleaseEnvironmentGuard(environmentGuard);
      }
    }

    public static NativeProcessCaptureResult Receive(NativeProcessSupervisor supervisor, int maximumStdoutBytes, int maximumStderrBytes) {
      if (supervisor == null || supervisor.ReceiveAttempted || maximumStdoutBytes != MaximumCaptureBytes || maximumStderrBytes != MaximumCaptureBytes)
        throw new InvalidOperationException("capture-invalid");
      supervisor.ReceiveAttempted = true;
      try {
        if (supervisor.StdoutTask == null || supervisor.StderrTask == null) throw new InvalidOperationException("capture-invalid");
        int firstDrain = Task.WaitAny(supervisor.StdoutTask, supervisor.StderrTask);
        if (firstDrain == 0) {
          supervisor.StdoutCapture = supervisor.StdoutTask.Result;
          if (!supervisor.StdoutCapture.DrainCompleted) throw new InvalidOperationException("capture-invalid");
          supervisor.StderrCapture = supervisor.StderrTask.Result;
          if (!supervisor.StderrCapture.DrainCompleted) throw new InvalidOperationException("capture-invalid");
        } else {
          supervisor.StderrCapture = supervisor.StderrTask.Result;
          if (!supervisor.StderrCapture.DrainCompleted) throw new InvalidOperationException("capture-invalid");
          supervisor.StdoutCapture = supervisor.StdoutTask.Result;
          if (!supervisor.StdoutCapture.DrainCompleted) throw new InvalidOperationException("capture-invalid");
        }
        if (supervisor.StdoutCapture.Eof && supervisor.StderrCapture.Eof &&
            supervisor.StdoutCapture.Sha256 != null && supervisor.StderrCapture.Sha256 != null) {
          supervisor.CaptureCompletedAtUtc = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fff'Z'", System.Globalization.CultureInfo.InvariantCulture);
          supervisor.CaptureComplete = true;
        }
        if (supervisor.WaitForExitFault) throw new InvalidOperationException("wait-for-exit-injected");
        supervisor.Process.WaitForExit();
        supervisor.ExitCode = supervisor.Process.ExitCode;
        supervisor.ExitedAtUtc = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fff'Z'", System.Globalization.CultureInfo.InvariantCulture);
        supervisor.SettlementComplete = true;
        if (!supervisor.StdoutCapture.Eof || !supervisor.StderrCapture.Eof ||
            supervisor.StdoutCapture.Sha256 == null || supervisor.StderrCapture.Sha256 == null)
          throw new InvalidOperationException("capture-invalid");
        return new NativeProcessCaptureResult(supervisor.StdoutCapture, supervisor.StderrCapture);
      } finally {
        if (supervisor.SettlementComplete) {
          ReleaseEnvironmentGuard(supervisor.EnvironmentGuard);
          supervisor.EnvironmentGuard = null;
        }
        supervisor.Process.Dispose();
      }
    }

    public static NativeProcessCaptureResult GetAvailableCapture(NativeProcessSupervisor supervisor) {
      if (supervisor == null || (supervisor.StdoutCapture == null && supervisor.StderrCapture == null))
        throw new InvalidOperationException("capture-invalid");
      NativeStreamCapture stdout = supervisor.StdoutCapture ?? MissingCapture(true);
      NativeStreamCapture stderr = supervisor.StderrCapture ?? MissingCapture(false);
      return new NativeProcessCaptureResult(stdout, stderr);
    }

    public static bool GetStdoutEof(NativeProcessSupervisor supervisor) {
      return supervisor != null && supervisor.StdoutCapture != null && supervisor.StdoutCapture.Eof;
    }

    public static bool GetStderrEof(NativeProcessSupervisor supervisor) {
      return supervisor != null && supervisor.StderrCapture != null && supervisor.StderrCapture.Eof;
    }

    public static int GetSettledExitCode(NativeProcessSupervisor supervisor) {
      if (supervisor == null || !supervisor.SettlementComplete) throw new InvalidOperationException("settlement-invalid");
      return supervisor.ExitCode;
    }

    public static string GetStartedObservedAtUtc(NativeProcessSupervisor supervisor) {
      if (supervisor == null) throw new InvalidOperationException("settlement-invalid");
      return supervisor.StartedObservedAtUtc;
    }

    public static string GetCaptureCompletedAtUtc(NativeProcessSupervisor supervisor) {
      if (supervisor == null || !supervisor.CaptureComplete) throw new InvalidOperationException("capture-invalid");
      return supervisor.CaptureCompletedAtUtc;
    }

    public static string GetExitedAtUtc(NativeProcessSupervisor supervisor) {
      if (supervisor == null || !supervisor.SettlementComplete) throw new InvalidOperationException("settlement-invalid");
      return supervisor.ExitedAtUtc;
    }

    private static NativeStreamCapture MissingCapture(bool retain) {
      return new NativeStreamCapture { Retained = retain ? new byte[0] : null, Count = 0, Sha256 = null,
        Overflow = false, Eof = false, DrainCompleted = false };
    }

    private static Task<NativeStreamCapture> DrainAsync(Stream stream, bool retain, bool injectCaptureFault, bool injectReadFault) {
      if (stream == null) throw new InvalidOperationException("capture-invalid");
      return Task.Run(() => {
        MemoryStream kept = retain ? new MemoryStream() : null;
        SHA256 algorithm = SHA256.Create();
        byte[] buffer = new byte[4096];
        long count = 0;
        bool captureFault = false;
        try {
          while (true) {
            int read = stream.Read(buffer, 0, buffer.Length);
            if (read == 0) break;
            count = checked(count + read);
            if (!captureFault) {
              try {
                algorithm.TransformBlock(buffer, 0, read, buffer, 0);
                if (injectCaptureFault) throw new IOException("capture-fault-injected");
              } catch { captureFault = true; }
            }
            if (retain && kept.Length < MaximumCaptureBytes) {
              int available = checked(MaximumCaptureBytes - (int)kept.Length);
              kept.Write(buffer, 0, Math.Min(read, available));
            }
            if (injectReadFault) throw new IOException("stream-read-fault-injected");
          }
          if (!captureFault) algorithm.TransformFinalBlock(new byte[0], 0, 0);
          return new NativeStreamCapture {
            Retained = retain ? kept.ToArray() : null, Count = count,
            Sha256 = captureFault ? null : BitConverter.ToString(algorithm.Hash).Replace("-", "").ToLowerInvariant(),
            Overflow = count > MaximumCaptureBytes, Eof = !captureFault, DrainCompleted = true
          };
        } catch {
          return new NativeStreamCapture { Retained = retain ? kept.ToArray() : null, Count = count,
            Sha256 = null, Overflow = count > MaximumCaptureBytes, Eof = false, DrainCompleted = false };
        } finally {
          if (kept != null) kept.Dispose();
          algorithm.Dispose();
        }
      });
    }

    private static void ValidateStartInfo(ProcessRole role, ProcessStartInfo info, NativeProcessBindings bindings) {
      if (info == null || info.UseShellExecute || !info.RedirectStandardOutput || !info.RedirectStandardError ||
          !info.CreateNoWindow || info.WindowStyle != ProcessWindowStyle.Hidden ||
          !PathRules.IsFullyQualifiedWindowsPath(info.FileName) || !PathRules.IsFullyQualifiedWindowsPath(info.WorkingDirectory))
        throw new InvalidOperationException("process-vector-invalid");
      if (bindings == null || bindings.Role != role ||
          !String.Equals(info.FileName, bindings.ExecutablePath, StringComparison.Ordinal) ||
          !String.Equals(info.WorkingDirectory, bindings.WorkingDirectory, StringComparison.Ordinal))
        throw new InvalidOperationException("process-bindings-invalid");
      ValidateEnvironment(info, role == ProcessRole.Controller ? 6 : 8);
      string[] arguments = ParseArguments(info.Arguments);
      if (role == ProcessRole.Controller) {
        ValidateController(info, arguments);
        if (!String.Equals(arguments[3], bindings.ControllerPath, StringComparison.Ordinal) ||
            !String.Equals(arguments[6], bindings.ExpectedCommit, StringComparison.Ordinal) ||
            !String.Equals(arguments[8], bindings.PnpmPath, StringComparison.Ordinal) ||
            !String.Equals(arguments[10], bindings.PnpmSha256, StringComparison.Ordinal))
          throw new InvalidOperationException("process-bindings-invalid");
      } else if (role == ProcessRole.GitObservation) ValidateGit(info, arguments);
      else throw new InvalidOperationException("process-role-invalid");
    }

    private static void ValidateEnvironment(ProcessStartInfo info, int count) {
      if (info.EnvironmentVariables.Count != count) throw new InvalidOperationException("process-environment-invalid");
      string[] values = new string[] { "C:\\Windows", "C:\\Windows", "C:\\Users\\synthetic-user\\AppData\\Local\\Temp",
        "C:\\Users\\synthetic-user\\AppData\\Local\\Temp", "C:\\Windows\\System32\\cmd.exe", "1" };
      for (int index = 0; index < CommonEnvironmentNames.Length; index++) {
        if (!String.Equals(info.EnvironmentVariables[CommonEnvironmentNames[index]], values[index], StringComparison.Ordinal))
          throw new InvalidOperationException("process-environment-invalid");
      }
      if (count == 8 && (!String.Equals(info.EnvironmentVariables["GIT_CONFIG_NOSYSTEM"], "1", StringComparison.Ordinal) ||
          !String.Equals(info.EnvironmentVariables["GIT_CONFIG_GLOBAL"], "NUL", StringComparison.Ordinal)))
        throw new InvalidOperationException("process-environment-invalid");
    }

    private static void ValidateController(ProcessStartInfo info, string[] arguments) {
      if (!String.Equals(info.FileName, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", StringComparison.Ordinal) ||
          arguments.Length != 11 || arguments[0] != "-NoProfile" || arguments[1] != "-NonInteractive" || arguments[2] != "-File" ||
          !PathRules.IsFullyQualifiedWindowsPath(arguments[3]) ||
          !String.Equals(Path.GetFileName(arguments[3]), "desktop-release-preflight-out-preservation.ps1", StringComparison.Ordinal) ||
          arguments[4] != "-Execute" || arguments[5] != "-ExpectedCommit" || !IsLowerHex(arguments[6], 40) ||
          arguments[7] != "-PnpmExecutable" || !PathRules.IsFullyQualifiedWindowsPath(arguments[8]) ||
          arguments[9] != "-ExpectedPnpmSha256" || !IsLowerHex(arguments[10], 64))
        throw new InvalidOperationException("controller-vector-invalid");
      string scripts = Path.GetDirectoryName(arguments[3]);
      string root = Path.GetDirectoryName(scripts);
      if (!String.Equals(root, info.WorkingDirectory, StringComparison.Ordinal)) throw new InvalidOperationException("controller-vector-invalid");
    }

    private static void ValidateGit(ProcessStartInfo info, string[] arguments) {
      if (!String.Equals(Path.GetFileName(info.FileName), "git.exe", StringComparison.OrdinalIgnoreCase) || arguments.Length < 7 ||
          arguments[0] != "--no-optional-locks" || arguments[1] != "-c" || arguments[2] != "core.fsmonitor=false" ||
          arguments[3] != "-C" || !String.Equals(arguments[4], info.WorkingDirectory, StringComparison.Ordinal))
        throw new InvalidOperationException("git-vector-invalid");
      bool root = arguments.Length == 7 && arguments[5] == "rev-parse" && arguments[6] == "--show-toplevel";
      bool branch = arguments.Length == 9 && arguments[5] == "symbolic-ref" && arguments[6] == "--quiet" && arguments[7] == "--short" && arguments[8] == "HEAD";
      bool head = arguments.Length == 8 && arguments[5] == "rev-parse" && arguments[6] == "--verify" && arguments[7] == "HEAD";
      bool status = arguments.Length == 8 && arguments[5] == "status" && arguments[6] == "--porcelain=v1" && arguments[7] == "--untracked-files=no";
      if (!root && !branch && !head && !status) throw new InvalidOperationException("git-vector-invalid");
    }

    private static string[] ParseArguments(string text) {
      int count;
      IntPtr memory = Native.CommandLineToArgvW("fixture.exe " + text, out count);
      if (memory == IntPtr.Zero || count < 1) throw new InvalidOperationException("process-vector-invalid");
      try {
        string[] result = new string[count - 1];
        for (int index = 1; index < count; index++)
          result[index - 1] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(memory, index * IntPtr.Size));
        return result;
      } finally { Native.LocalFree(memory); }
    }

    private static bool IsLowerHex(string value, int length) {
      if (value == null || value.Length != length) return false;
      foreach (char character in value) if (!((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f'))) return false;
      return true;
    }
  }

  public sealed class ValidatedAuthorizationContext : IDisposable {
    public object Document { get; private set; }
    public PinnedManifestFile ManifestGuard { get; private set; }
    public byte[] ExactBytes { get; private set; }
    public string Sha256 { get; private set; }
    public object Invocation { get; private set; }
    public object Contract { get; private set; }

    public ValidatedAuthorizationContext(object document, PinnedManifestFile guard, byte[] exactBytes, string sha256, object invocation, object contract) {
      Document = document; ManifestGuard = guard; ExactBytes = exactBytes; Sha256 = sha256; Invocation = invocation; Contract = contract;
    }

    public void Dispose() {
      PinnedManifestFile guard = ManifestGuard; ManifestGuard = null;
      if (guard != null) guard.Dispose();
    }
  }
}
'@ -ErrorAction Stop
}

function Get-IntentArcPreflightExecutionSha256 {
    param([Parameter(Mandatory)][AllowEmptyCollection()][byte[]] $Bytes)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($algorithm.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $algorithm.Dispose() }
}

function Test-IntentArcPreflightExecutionFixedTimeText {
    param([Parameter(Mandatory)][string] $Left, [Parameter(Mandatory)][string] $Right)
    if ($Left.Length -ne $Right.Length) { return $false }
    $difference = 0
    for ($index = 0; $index -lt $Left.Length; $index++) {
        $difference = $difference -bor ([int][char]$Left[$index] -bxor [int][char]$Right[$index])
    }
    return $difference -eq 0
}

function Test-IntentArcPreflightExecutionFixedText {
    param([Parameter(Mandatory)] $Actual, [Parameter(Mandatory)][string] $Expected)
    return ($Actual -is [string]) -and [string]::Equals($Actual, $Expected, [StringComparison]::Ordinal)
}

function Test-IntentArcPreflightExecutionFullyQualifiedWindowsPath {
    param($Value)
    if ($Value -isnot [string]) { return $false }
    Initialize-IntentArcPreflightExecutionNative
    try { return [IntentArc.PreflightEnvelope.PathRules]::IsFullyQualifiedWindowsPath($Value) }
    catch { return $false }
}

function Test-IntentArcPreflightExecutionExactPropertyNames {
    param([Parameter(Mandatory)] $Value, [Parameter(Mandatory)][string[]] $Expected)
    if ($null -eq $Value) { return $false }
    $actual = @($Value.PSObject.Properties | ForEach-Object { $_.Name })
    if ($actual.Count -ne $Expected.Count) { return $false }
    $set = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($name in $Expected) { [void] $set.Add($name) }
    foreach ($name in $actual) { if ($name -isnot [string] -or -not $set.Contains($name)) { return $false } }
    return $true
}

function Test-IntentArcPreflightExecutionExactBindings {
    param([Parameter(Mandatory)] $Bindings, [Parameter(Mandatory)][Collections.IDictionary] $Expected)
    if ($Bindings -isnot [Collections.IDictionary] -or $Bindings.Count -ne $Expected.Count) { return $false }
    $actualKeys = @($Bindings.Keys)
    foreach ($expectedName in $Expected.Keys) {
        $actualName = $null
        foreach ($candidate in $actualKeys) {
            if ($candidate -is [string] -and [string]::Equals($candidate, [string]$expectedName, [StringComparison]::Ordinal)) { $actualName = $candidate; break }
        }
        if ($null -eq $actualName -or $Bindings[$actualName] -isnot [string] -or -not [string]::Equals($Bindings[$actualName], $Expected[$expectedName], [StringComparison]::Ordinal)) { return $false }
    }
    return $true
}

function New-IntentArcPreflightEnvelopeProductionContract {
    param()
    if ($args.Count -ne 0) { Throw-IntentArcPreflightExecutionAuthorizationInvalid }
    $bindings = [ordered]@{
        envelope = $script:IntentArcPreflightExecutionEnvelopePath
        controller = 'C:\projects\Project Manager\scripts\desktop-release-preflight-out-preservation.ps1'
        git = 'C:\Program Files\Git\cmd\git.exe'
        node = 'C:\Program Files\nodejs\node.exe'
        cmd = 'C:\Windows\System32\cmd.exe'
        pnpm = 'C:\Users\synthetic-user\AppData\Local\pnpm\global\v11\synthetic-install\node_modules\@pnpm\exe\pnpm.exe'
        host = $script:IntentArcPreflightExecutionPowerShellPath
    }
    return [pscustomobject][ordered]@{
        Internal = $false
        Root = 'C:\projects\Project Manager'
        AuthorizationManifestPath = $script:IntentArcPreflightExecutionManifestPath
        ExecutableBindings = $bindings
    }
}

function New-IntentArcPreflightEnvelopeTestContract {
    param([Parameter(Mandatory)][string] $Root, [Parameter(Mandatory)][Collections.IDictionary] $ExecutableBindings)
    if (-not $script:IntentArcPreflightEnvelopeWasDotSourced -or $args.Count -ne 0 -or -not (Test-IntentArcPreflightExecutionFullyQualifiedWindowsPath $Root)) {
        Throw-IntentArcPreflightExecutionAuthorizationInvalid
    }
    $names = [string[]] @('envelope', 'controller', 'git', 'node', 'cmd', 'pnpm', 'host')
    $expectedShape = [ordered]@{}
    foreach ($name in $names) { $expectedShape[$name] = [string] $ExecutableBindings[$name] }
    if (-not (Test-IntentArcPreflightExecutionExactBindings -Bindings $ExecutableBindings -Expected $expectedShape)) { Throw-IntentArcPreflightExecutionAuthorizationInvalid }
    foreach ($name in $names) {
        if (-not (Test-IntentArcPreflightExecutionFullyQualifiedWindowsPath $ExecutableBindings[$name])) {
            Throw-IntentArcPreflightExecutionAuthorizationInvalid
        }
    }
    $copy = [ordered]@{}
    foreach ($name in $names) { $copy[$name] = [string] $ExecutableBindings[$name] }
    Initialize-IntentArcPreflightExecutionNative
    try { return [IntentArc.PreflightEnvelope.TestContractFactory]::Create($Root, $copy) }
    catch { Throw-IntentArcPreflightExecutionAuthorizationInvalid }
}

function Test-IntentArcPreflightEnvelopeContract {
    param([Parameter(Mandatory)] $Contract)
    try {
        if ($null -eq $Contract -or $Contract.Internal -isnot [bool]) { return $false }
        if ($Contract.Internal -eq $false) {
            if (-not (Test-IntentArcPreflightExecutionExactPropertyNames -Value $Contract -Expected @('Internal', 'Root', 'AuthorizationManifestPath', 'ExecutableBindings'))) { return $false }
            $expected = New-IntentArcPreflightEnvelopeProductionContract
            if ($Contract.Root -isnot [string] -or $Contract.AuthorizationManifestPath -isnot [string] -or
                -not [string]::Equals($Contract.Root, $expected.Root, [StringComparison]::Ordinal) -or
                -not [string]::Equals($Contract.AuthorizationManifestPath, $expected.AuthorizationManifestPath, [StringComparison]::Ordinal)) { return $false }
            return Test-IntentArcPreflightExecutionExactBindings -Bindings $Contract.ExecutableBindings -Expected $expected.ExecutableBindings
        }
        if (-not $script:IntentArcPreflightEnvelopeWasDotSourced -or
            $Contract.GetType() -ne [IntentArc.PreflightEnvelope.TestContract] -or
            -not [IntentArc.PreflightEnvelope.TestContractFactory]::IsIssued($Contract) -or
            -not (Test-IntentArcPreflightExecutionExactPropertyNames -Value $Contract -Expected @('Internal', 'Root', 'ExecutableBindings', 'TestHooks')) -or
            -not (Test-IntentArcPreflightExecutionFullyQualifiedWindowsPath $Contract.Root) -or
            $Contract.TestHooks -isnot [IntentArc.PreflightEnvelope.TestHooks]) { return $false }
        $shape = [ordered]@{}
        foreach ($name in @('envelope', 'controller', 'git', 'node', 'cmd', 'pnpm', 'host')) {
            $binding = $Contract.ExecutableBindings[$name]
            if (-not (Test-IntentArcPreflightExecutionFullyQualifiedWindowsPath $binding)) { return $false }
            $shape[$name] = $binding
        }
        return Test-IntentArcPreflightExecutionExactBindings -Bindings $Contract.ExecutableBindings -Expected $shape
    } catch { return $false }
}

function Test-IntentArcPreflightEnvelopeInternalContract {
    param([Parameter(Mandatory)] $Contract)
    if (-not (Test-IntentArcPreflightEnvelopeContract $Contract)) { return $false }
    return $Contract.Internal -is [bool] -and $Contract.Internal -eq $true
}

function ConvertFrom-IntentArcPreflightExecutionWindowsCommandLine {
    param([Parameter(Mandatory)][string] $CommandLine)
    Initialize-IntentArcPreflightExecutionNative
    $count = 0
    $memory = [IntentArc.PreflightEnvelope.Native]::CommandLineToArgvW($CommandLine, [ref]$count)
    if ($memory -eq [IntPtr]::Zero -or $count -lt 1) { Throw-IntentArcPreflightExecutionAuthorizationInvalid }
    try {
        $items = [string[]]::new($count)
        for ($index = 0; $index -lt $count; $index++) {
            $items[$index] = [Runtime.InteropServices.Marshal]::PtrToStringUni([Runtime.InteropServices.Marshal]::ReadIntPtr($memory, $index * [IntPtr]::Size))
        }
        return $items
    } finally { [void] [IntentArc.PreflightEnvelope.Native]::LocalFree($memory) }
}

function Get-IntentArcPreflightExecutionProductionInvocationMetadata {
    param()
    if ($args.Count -ne 0) { Throw-IntentArcPreflightExecutionAuthorizationInvalid }
    Initialize-IntentArcPreflightExecutionNative
    $process = [Diagnostics.Process]::GetCurrentProcess()
    try {
        $image = [Text.StringBuilder]::new(32768)
        $size = [uint32] $image.Capacity
        if (-not [IntentArc.PreflightEnvelope.Native]::QueryFullProcessImageNameW($process.Handle, 0, $image, [ref]$size)) { Throw-IntentArcPreflightExecutionAuthorizationInvalid }
        $pointer = [IntentArc.PreflightEnvelope.Native]::GetCommandLineW()
        if ($pointer -eq [IntPtr]::Zero) { Throw-IntentArcPreflightExecutionAuthorizationInvalid }
        $commandLine = [Runtime.InteropServices.Marshal]::PtrToStringUni($pointer)
        $actualScriptPath = $PSCommandPath
        if ([string]::IsNullOrEmpty($image.ToString()) -or [string]::IsNullOrEmpty($commandLine) -or [string]::IsNullOrEmpty($actualScriptPath)) {
            Throw-IntentArcPreflightExecutionAuthorizationInvalid
        }
        return [pscustomobject][ordered]@{ HostImagePath = $image.ToString(); RawCommandLine = $commandLine; EnvelopePath = $actualScriptPath }
    } finally { $process.Dispose() }
}

function ConvertTo-IntentArcPreflightExecutionQuotedArgument {
    param([Parameter(Mandatory)][string] $Value)
    return '"' + (($Value -replace '(\\*)"', '$1$1\\"') -replace '(\\+)$', '$1$1') + '"'
}

function Set-IntentArcPreflightClosedProcessEnvironment {
    param([Parameter(Mandatory)][Diagnostics.ProcessStartInfo] $StartInfo, [Parameter(Mandatory)][bool] $Git)
    $StartInfo.EnvironmentVariables.Clear()
    $StartInfo.EnvironmentVariables['SystemRoot'] = 'C:\Windows'
    $StartInfo.EnvironmentVariables['WINDIR'] = 'C:\Windows'
    $StartInfo.EnvironmentVariables['TEMP'] = 'C:\Users\synthetic-user\AppData\Local\Temp'
    $StartInfo.EnvironmentVariables['TMP'] = 'C:\Users\synthetic-user\AppData\Local\Temp'
    $StartInfo.EnvironmentVariables['ComSpec'] = 'C:\Windows\System32\cmd.exe'
    $StartInfo.EnvironmentVariables['NoDefaultCurrentDirectoryInExePath'] = '1'
    if ($Git) {
        $StartInfo.EnvironmentVariables['GIT_CONFIG_NOSYSTEM'] = '1'
        $StartInfo.EnvironmentVariables['GIT_CONFIG_GLOBAL'] = 'NUL'
    }
}

function New-IntentArcPreflightClosedProcessStartInfo {
    param(
        [Parameter(Mandatory)][string] $FileName,
        [Parameter(Mandatory)][string[]] $ArgumentTokens,
        [Parameter(Mandatory)][string] $WorkingDirectory,
        [Parameter(Mandatory)][bool] $Git
    )
    if (-not (Test-IntentArcPreflightExecutionFullyQualifiedWindowsPath $FileName) -or
        -not (Test-IntentArcPreflightExecutionFullyQualifiedWindowsPath $WorkingDirectory) -or $ArgumentTokens.Count -lt 1) {
        throw 'process-vector-invalid'
    }
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $FileName
    $info.Arguments = (@($ArgumentTokens | ForEach-Object { ConvertTo-IntentArcPreflightExecutionQuotedArgument ([string]$_) }) -join ' ')
    $info.WorkingDirectory = $WorkingDirectory
    $info.UseShellExecute = $false
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.CreateNoWindow = $true
    $info.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    Set-IntentArcPreflightClosedProcessEnvironment -StartInfo $info -Git $Git
    return $info
}

function New-IntentArcPreflightControllerStartInfo {
    param([Parameter(Mandatory)] $AuthorizationDocument)
    try {
        $controllerArguments = [string[]] @(
            '-NoProfile', '-NonInteractive', '-File', [string]$AuthorizationDocument.controllerPath,
            '-Execute', '-ExpectedCommit', [string]$AuthorizationDocument.expectedCommit,
            '-PnpmExecutable', [string]$AuthorizationDocument.pnpmPath,
            '-ExpectedPnpmSha256', [string]$AuthorizationDocument.pnpmSha256
        )
        return New-IntentArcPreflightClosedProcessStartInfo -FileName ([string]$AuthorizationDocument.outerPowerShellPath) `
            -ArgumentTokens $controllerArguments -WorkingDirectory ([string]$AuthorizationDocument.canonicalPath) -Git $false
    } catch { throw 'controller-vector-invalid' }
}

function New-IntentArcPreflightControllerLaunchBindings {
    param([Parameter(Mandatory)] $AuthorizationDocument)
    Initialize-IntentArcPreflightExecutionNative
    try {
        return [IntentArc.PreflightEnvelope.NativeProcessDispatcher]::CreateControllerBindings(
            [string]$AuthorizationDocument.outerPowerShellPath, [string]$AuthorizationDocument.canonicalPath,
            [string]$AuthorizationDocument.controllerPath, [string]$AuthorizationDocument.pnpmPath,
            [string]$AuthorizationDocument.expectedCommit, [string]$AuthorizationDocument.pnpmSha256)
    } catch { throw 'controller-bindings-invalid' }
}

function New-IntentArcPreflightGitObservationStartInfo {
    param([Parameter(Mandatory)] $AuthorizationDocument, [Parameter(Mandatory)][string] $Observation)
    $suffix = switch -CaseSensitive ($Observation) {
        'root' { [string[]] @('rev-parse', '--show-toplevel'); break }
        'branch' { [string[]] @('symbolic-ref', '--quiet', '--short', 'HEAD'); break }
        'head' { [string[]] @('rev-parse', '--verify', 'HEAD'); break }
        'status' { [string[]] @('status', '--porcelain=v1', '--untracked-files=no'); break }
        default { throw 'git-vector-invalid' }
    }
    $arguments = [Collections.Generic.List[string]]::new()
    foreach ($token in @('--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', [string]$AuthorizationDocument.canonicalPath)) { [void]$arguments.Add($token) }
    foreach ($token in $suffix) { [void]$arguments.Add($token) }
    try {
        return New-IntentArcPreflightClosedProcessStartInfo -FileName ([string]$AuthorizationDocument.gitPath) `
            -ArgumentTokens $arguments.ToArray() -WorkingDirectory ([string]$AuthorizationDocument.canonicalPath) -Git $true
    } catch { throw 'git-vector-invalid' }
}

function New-IntentArcPreflightGitObservationBindings {
    param([Parameter(Mandatory)] $AuthorizationDocument)
    Initialize-IntentArcPreflightExecutionNative
    try {
        return [IntentArc.PreflightEnvelope.NativeProcessDispatcher]::CreateGitBindings(
            [string]$AuthorizationDocument.gitPath, [string]$AuthorizationDocument.canonicalPath)
    } catch { throw 'git-bindings-invalid' }
}

function New-IntentArcPreflightControllerLaunchGate {
    param([Parameter(Mandatory)][bool] $DurableConsumptionValidated)
    Initialize-IntentArcPreflightExecutionNative
    try { return [IntentArc.PreflightEnvelope.NativeProcessDispatcher]::CreateControllerLaunchGate($DurableConsumptionValidated) }
    catch { throw 'consumption-gate-invalid' }
}

function Receive-IntentArcPreflightControllerOutput {
    param(
        [Parameter(Mandatory)][IntentArc.PreflightEnvelope.NativeProcessSupervisor] $Supervisor,
        [Parameter(Mandatory)][int] $MaximumStdoutBytes,
        [Parameter(Mandatory)][int] $MaximumStderrBytes
    )
    try {
        $capture = [IntentArc.PreflightEnvelope.NativeProcessDispatcher]::Receive($Supervisor, $MaximumStdoutBytes, $MaximumStderrBytes)
        return [pscustomobject][ordered]@{
            stdout = [byte[]]$capture.stdout
            stdoutBytes = [long]$capture.stdoutBytes
            stdoutSha256 = [string]$capture.stdoutSha256
            stderrBytes = [long]$capture.stderrBytes
            stderrSha256 = [string]$capture.stderrSha256
            stdoutOverflow = [bool]$capture.stdoutOverflow
            stderrOverflow = [bool]$capture.stderrOverflow
        }
    } catch { throw 'capture-invalid' }
}

function Invoke-IntentArcPreflightGitObservation {
    param([Parameter(Mandatory)] $AuthorizationDocument, [Parameter(Mandatory)][string] $Observation, [string] $Fault)
    Initialize-IntentArcPreflightExecutionNative
    $launch = $null
    try {
        $info = New-IntentArcPreflightGitObservationStartInfo -AuthorizationDocument $AuthorizationDocument -Observation $Observation
        $bindings = New-IntentArcPreflightGitObservationBindings -AuthorizationDocument $AuthorizationDocument
        $launch = [IntentArc.PreflightEnvelope.NativeProcessDispatcher]::Run(
            [IntentArc.PreflightEnvelope.ProcessRole]::GitObservation, $info, $bindings, $null, $Fault)
        if (-not $launch.processCreated -or -not $launch.supervisorIdentityValid -or -not $launch.drainsInitialized -or $launch.setupCategory -cne 'none') {
            throw 'git-observation-invalid'
        }
        $capture = Receive-IntentArcPreflightControllerOutput -Supervisor $launch.supervisor `
            -MaximumStdoutBytes 1048576 -MaximumStderrBytes 1048576
        $exitCode = [IntentArc.PreflightEnvelope.NativeProcessDispatcher]::GetSettledExitCode($launch.supervisor)
        if ($exitCode -ne 0 -or $capture.stdoutOverflow -or $capture.stderrOverflow -or $capture.stderrBytes -ne 0) {
            throw 'git-observation-invalid'
        }
        $text = [Text.UTF8Encoding]::new($false, $true).GetString($capture.stdout)
        return [pscustomobject][ordered]@{
            stdoutText = $text
            stdoutBytes = $capture.stdoutBytes
            stdoutSha256 = $capture.stdoutSha256
            stderrBytes = $capture.stderrBytes
            stderrSha256 = $capture.stderrSha256
            exitCode = $exitCode
        }
    } catch {
        if ($null -ne $launch -and $launch.processCreated -and $null -ne $launch.supervisor) {
            try { [void](Receive-IntentArcPreflightControllerOutput -Supervisor $launch.supervisor `
                -MaximumStdoutBytes 1048576 -MaximumStderrBytes 1048576) } catch {}
        }
        throw 'git-observation-invalid'
    }
}

function Write-IntentArcPreflightCapturedControllerOutput {
    param(
        [Parameter(Mandatory)][IntentArc.PreflightEnvelope.BoundaryGuard] $RootGuard,
        [Parameter(Mandatory)] $Capture
    )
    $keys = @('stdout', 'stdoutBytes', 'stdoutSha256', 'stderrBytes', 'stderrSha256', 'stdoutOverflow', 'stderrOverflow')
    if (-not (Test-IntentArcPreflightEnvelopeOrderedPropertyNames -Value $Capture -Expected $keys) -or
        $Capture.stdout -isnot [byte[]] -or $Capture.stdoutBytes -isnot [long] -or $Capture.stderrBytes -isnot [long] -or
        $Capture.stdoutSha256 -isnot [string] -or $Capture.stdoutSha256 -cnotmatch '^[0-9a-f]{64}$' -or
        ($null -ne $Capture.stderrSha256 -and ($Capture.stderrSha256 -isnot [string] -or $Capture.stderrSha256 -cnotmatch '^[0-9a-f]{64}$')) -or
        $Capture.stdoutOverflow -isnot [bool] -or $Capture.stderrOverflow -isnot [bool] -or
        $Capture.stdoutOverflow -or $Capture.stdoutBytes -ne $Capture.stdout.Length -or $Capture.stdoutBytes -gt 1048576 -or
        -not (Test-IntentArcPreflightExecutionFixedTimeText -Left (Get-IntentArcPreflightExecutionSha256 -Bytes $Capture.stdout) -Right $Capture.stdoutSha256)) {
        throw 'capture-invalid'
    }
    if ($Capture.stdout.Length -eq 0) {
        $emptyGuard = $null
        try {
            $emptyGuard = [IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::WriteAtomicNew(
                $RootGuard, 'controller-stdout.json', [byte[]]::new(0))
            $emptyBytes = $emptyGuard.ReadAllBytes(1048576)
            if ($emptyBytes.Length -ne 0 -or -not [IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::ValidateProtection($emptyGuard)) {
                throw 'capture-invalid'
            }
            return [pscustomobject][ordered]@{ sha256 = Get-IntentArcPreflightExecutionSha256 -Bytes ([byte[]]::new(0)) }
        } finally { if ($null -ne $emptyGuard) { $emptyGuard.Dispose() } }
    }
    return Write-IntentArcPreflightEnvelopeImmutableBytes -RootGuard $RootGuard -Leaf 'controller-stdout.json' `
        -Bytes $Capture.stdout -MaximumBytes 1048576
}

function Write-IntentArcPreflightEnvelopeAttemptReceipt {
    param(
        [Parameter(Mandatory)][IntentArc.PreflightEnvelope.BoundaryGuard] $RootGuard,
        [Parameter(Mandatory)] $Document
    )
    if (-not (Test-IntentArcPreflightAttemptReceipt -Document $Document)) { throw 'attempt-receipt-invalid' }
    $ordered = [ordered]@{}
    foreach ($name in @(
        'schema', 'attemptId', 'controllerRunId', 'launchAttemptedAtUtc', 'controllerStartedAtUtc',
        'controllerProcessId', 'controllerStartTimeUtc', 'captureCompletedAtUtc', 'controllerExitedAtUtc',
        'controllerExitCode', 'stdoutBytes', 'stdoutSha256', 'stderrBytes', 'stderrSha256',
        'stdoutOverflow', 'stderrOverflow', 'stdoutEof', 'stderrEof', 'processSettled',
        'infrastructureCategory', 'recordedAtUtc'
    )) { $ordered[$name] = $Document.$name }
    $bytes = ConvertTo-IntentArcPreflightEnvelopeCanonicalBytes -Document $ordered
    return Write-IntentArcPreflightEnvelopeImmutableBytes -RootGuard $RootGuard -Leaf 'attempt-receipt.json' `
        -Bytes $bytes -MaximumBytes 32768
}

function Finalize-IntentArcPreflightControllerAttempt {
    param(
        [Parameter(Mandatory)][IntentArc.PreflightEnvelope.BoundaryGuard] $RootGuard,
        [Parameter(Mandatory)] $Launch,
        [Parameter(Mandatory)][bool] $ControllerStartedValid,
        [Parameter(Mandatory)][string] $LaunchAttemptedAtUtc,
        [string] $Fault
    )
    Assert-IntentArcPreflightEnvelopeLaunchRecord -Record $Launch
    if (-not (Test-IntentArcPreflightExecutionCanonicalTimestamp $LaunchAttemptedAtUtc) -or
        (-not [string]::IsNullOrEmpty($Fault) -and @(
            'later-cancellation', 'drain-failure', 'settlement-uncertain',
            'host-loss-before-receipt', 'host-loss-after-receipt'
        ) -cnotcontains $Fault)) {
        throw 'attempt-finalization-invalid'
    }
    $startedAt = $null; $processId = $null; $processStart = $null
    $captureAt = $null; $exitAt = $null; $exitCode = $null
    [long]$stdoutBytes = 0; $stdoutSha256 = $null
    [long]$stderrBytes = 0; $stderrSha256 = $null
    $stdoutOverflow = $false; $stderrOverflow = $false
    $stdoutEof = $false; $stderrEof = $false; $processSettled = $false
    $capture = $null
    $category = 'launch-failed'
    if ($Launch.processCreated) {
        try {
            $capture = Receive-IntentArcPreflightControllerOutput -Supervisor $Launch.supervisor `
                -MaximumStdoutBytes 1048576 -MaximumStderrBytes 1048576
            if ($Launch.supervisorIdentityValid) {
                $startedAt = [IntentArc.PreflightEnvelope.NativeProcessDispatcher]::GetStartedObservedAtUtc($Launch.supervisor)
                $processId = [int]$Launch.supervisor.processId
                $processStart = [string]$Launch.supervisor.startTimeUtc
                $captureAt = [IntentArc.PreflightEnvelope.NativeProcessDispatcher]::GetCaptureCompletedAtUtc($Launch.supervisor)
                $exitAt = [IntentArc.PreflightEnvelope.NativeProcessDispatcher]::GetExitedAtUtc($Launch.supervisor)
                $exitCode = [int][IntentArc.PreflightEnvelope.NativeProcessDispatcher]::GetSettledExitCode($Launch.supervisor)
                $stdoutBytes = [long]$capture.stdoutBytes; $stdoutSha256 = [string]$capture.stdoutSha256
                $stderrBytes = [long]$capture.stderrBytes; $stderrSha256 = [string]$capture.stderrSha256
                $stdoutOverflow = [bool]$capture.stdoutOverflow; $stderrOverflow = [bool]$capture.stderrOverflow
                $stdoutEof = $true; $stderrEof = $true; $processSettled = $true
            }
        } catch {
            if ($Launch.supervisorIdentityValid) {
                $startedAt = [IntentArc.PreflightEnvelope.NativeProcessDispatcher]::GetStartedObservedAtUtc($Launch.supervisor)
                $processId = [int]$Launch.supervisor.processId
                $processStart = [string]$Launch.supervisor.startTimeUtc
                try {
                    $capture = [IntentArc.PreflightEnvelope.NativeProcessDispatcher]::GetAvailableCapture($Launch.supervisor)
                    $stdoutBytes = [long]$capture.stdoutBytes
                    $stdoutSha256 = if ($null -eq $capture.stdoutSha256) { $null } else { [string]$capture.stdoutSha256 }
                    $stderrBytes = [long]$capture.stderrBytes
                    $stderrSha256 = if ($null -eq $capture.stderrSha256) { $null } else { [string]$capture.stderrSha256 }
                    $stdoutOverflow = [bool]$capture.stdoutOverflow
                    $stderrOverflow = [bool]$capture.stderrOverflow
                    $stdoutEof = [IntentArc.PreflightEnvelope.NativeProcessDispatcher]::GetStdoutEof($Launch.supervisor)
                    $stderrEof = [IntentArc.PreflightEnvelope.NativeProcessDispatcher]::GetStderrEof($Launch.supervisor)
                    if ($stdoutEof -and $stderrEof) {
                        $captureAt = [IntentArc.PreflightEnvelope.NativeProcessDispatcher]::GetCaptureCompletedAtUtc($Launch.supervisor)
                    }
                } catch {}
                try {
                    $exitAt = [IntentArc.PreflightEnvelope.NativeProcessDispatcher]::GetExitedAtUtc($Launch.supervisor)
                    $exitCode = [int][IntentArc.PreflightEnvelope.NativeProcessDispatcher]::GetSettledExitCode($Launch.supervisor)
                    $processSettled = $true
                } catch {}
            }
        }
        if (-not $Launch.supervisorIdentityValid) {
            $startedAt = $null; $processId = $null; $processStart = $null; $captureAt = $null; $exitAt = $null; $exitCode = $null
            $stdoutBytes = 0; $stdoutSha256 = $null; $stderrBytes = 0; $stderrSha256 = $null
            $stdoutOverflow = $false; $stderrOverflow = $false; $stdoutEof = $false; $stderrEof = $false; $processSettled = $false
            $category = 'settlement-invalid'
        } elseif (-not $ControllerStartedValid) { $category = 'consumption-journal-invalid' }
        elseif ($Fault -ceq 'settlement-uncertain') {
            $exitAt = $null; $exitCode = $null; $processSettled = $false; $category = 'settlement-invalid'
        } elseif (-not $processSettled) { $category = 'settlement-invalid' }
        elseif (-not $Launch.drainsInitialized -or $Fault -ceq 'later-cancellation' -or $Fault -ceq 'drain-failure' -or
            $null -eq $capture -or -not $stdoutEof -or -not $stderrEof) {
            $category = 'capture-invalid'
        } elseif ($stdoutOverflow -or $stderrOverflow) { $category = 'capture-overflow' }
        else { $category = 'none' }
    }
    if ($null -ne $capture -and $stdoutEof -and -not $stdoutOverflow) {
        try { [void](Write-IntentArcPreflightCapturedControllerOutput -RootGuard $RootGuard -Capture $capture) }
        catch {
            # Persist the independent receipt with the known capture and settlement facts.
            # Earlier journal/settlement/overflow dispositions keep their precedence.
            if ($category -ceq 'none') { $category = 'capture-invalid' }
        }
    }
    if ($Fault -ceq 'host-loss-before-receipt') { throw 'host-loss-simulated' }
    $recordedAt = [DateTimeOffset]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fff'Z'", [Globalization.CultureInfo]::InvariantCulture)
    $receipt = [pscustomobject][ordered]@{
        schema = 'intentarc.preflight-execution-attempt-receipt/v1'
        attemptId = $script:IntentArcPreflightExecutionAttemptId
        controllerRunId = $script:IntentArcPreflightExecutionControllerRunId
        launchAttemptedAtUtc = $LaunchAttemptedAtUtc
        controllerStartedAtUtc = $startedAt
        controllerProcessId = $processId
        controllerStartTimeUtc = $processStart
        captureCompletedAtUtc = $captureAt
        controllerExitedAtUtc = $exitAt
        controllerExitCode = $exitCode
        stdoutBytes = $stdoutBytes
        stdoutSha256 = $stdoutSha256
        stderrBytes = $stderrBytes
        stderrSha256 = $stderrSha256
        stdoutOverflow = $stdoutOverflow
        stderrOverflow = $stderrOverflow
        stdoutEof = $stdoutEof
        stderrEof = $stderrEof
        processSettled = $processSettled
        infrastructureCategory = $category
        recordedAtUtc = $recordedAt
    }
    [void](Write-IntentArcPreflightEnvelopeAttemptReceipt -RootGuard $RootGuard -Document $receipt)
    if ($Fault -ceq 'host-loss-after-receipt') { throw 'host-loss-simulated' }
    return [pscustomobject][ordered]@{ finalized = $true }
}

function Test-IntentArcPreflightAttemptReceiptInteger {
    param($Value, [long] $Minimum, [long] $Maximum)
    return ($Value -is [int] -or $Value -is [long]) -and [long]$Value -ge $Minimum -and [long]$Value -le $Maximum
}

function Test-IntentArcPreflightAttemptReceiptNullableTimestamp {
    param($Value)
    return $null -eq $Value -or ($Value -is [string] -and (Test-IntentArcPreflightExecutionCanonicalTimestamp $Value))
}

function Test-IntentArcPreflightAttemptReceiptNullableInteger {
    param($Value)
    return $null -eq $Value -or (Test-IntentArcPreflightAttemptReceiptInteger -Value $Value -Minimum ([int]::MinValue) -Maximum ([int]::MaxValue))
}

function Test-IntentArcPreflightAttemptReceipt {
    param([Parameter(Mandatory)] $Document)
    try {
        $keys = [string[]] @(
            'schema', 'attemptId', 'controllerRunId', 'launchAttemptedAtUtc', 'controllerStartedAtUtc',
            'controllerProcessId', 'controllerStartTimeUtc', 'captureCompletedAtUtc', 'controllerExitedAtUtc',
            'controllerExitCode', 'stdoutBytes', 'stdoutSha256', 'stderrBytes', 'stderrSha256',
            'stdoutOverflow', 'stderrOverflow', 'stdoutEof', 'stderrEof', 'processSettled',
            'infrastructureCategory', 'recordedAtUtc'
        )
        if (-not (Test-IntentArcPreflightEnvelopeOrderedPropertyNames -Value $Document -Expected $keys) -or
            -not (Test-IntentArcPreflightExecutionFixedText -Actual $Document.schema -Expected 'intentarc.preflight-execution-attempt-receipt/v1') -or
            -not (Test-IntentArcPreflightExecutionFixedText -Actual $Document.attemptId -Expected $script:IntentArcPreflightExecutionAttemptId) -or
            -not (Test-IntentArcPreflightExecutionFixedText -Actual $Document.controllerRunId -Expected $script:IntentArcPreflightExecutionControllerRunId) -or
            -not (Test-IntentArcPreflightExecutionCanonicalTimestamp $Document.launchAttemptedAtUtc) -or
            -not (Test-IntentArcPreflightExecutionCanonicalTimestamp $Document.recordedAtUtc) -or
            [string]::CompareOrdinal($Document.launchAttemptedAtUtc, $Document.recordedAtUtc) -gt 0 -or
            -not (Test-IntentArcPreflightAttemptReceiptNullableTimestamp $Document.controllerStartedAtUtc) -or
            -not (Test-IntentArcPreflightAttemptReceiptNullableTimestamp $Document.controllerStartTimeUtc) -or
            -not (Test-IntentArcPreflightAttemptReceiptNullableTimestamp $Document.captureCompletedAtUtc) -or
            -not (Test-IntentArcPreflightAttemptReceiptNullableTimestamp $Document.controllerExitedAtUtc) -or
            -not (Test-IntentArcPreflightAttemptReceiptNullableInteger $Document.controllerExitCode) -or
            -not (Test-IntentArcPreflightAttemptReceiptInteger -Value $Document.stdoutBytes -Minimum 0 -Maximum 9007199254740991) -or
            -not (Test-IntentArcPreflightAttemptReceiptInteger -Value $Document.stderrBytes -Minimum 0 -Maximum 9007199254740991)) { return $false }
        foreach ($name in @('stdoutOverflow', 'stderrOverflow', 'stdoutEof', 'stderrEof', 'processSettled')) {
            if ($Document.$name -isnot [bool]) { return $false }
        }
        if ($Document.stdoutOverflow -ne ($Document.stdoutBytes -gt 1048576) -or
            $Document.stderrOverflow -ne ($Document.stderrBytes -gt 1048576)) { return $false }
        foreach ($prefix in @('stdout', 'stderr')) {
            $eof = $Document.($prefix + 'Eof')
            $hash = $Document.($prefix + 'Sha256')
            if ($eof) { if ($hash -isnot [string] -or $hash -cnotmatch '^[0-9a-f]{64}$') { return $false } }
            elseif ($null -ne $hash) { return $false }
        }
        $category = $Document.infrastructureCategory
        if ($category -isnot [string] -or @('none', 'launch-failed', 'consumption-journal-invalid', 'capture-overflow', 'capture-invalid', 'settlement-invalid') -cnotcontains $category) { return $false }
        $startedValues = @($Document.controllerStartedAtUtc, $Document.controllerProcessId, $Document.controllerStartTimeUtc)
        $started = $null -ne $Document.controllerStartedAtUtc
        if ($started) {
            if (-not (Test-IntentArcPreflightAttemptReceiptInteger -Value $Document.controllerProcessId -Minimum 1 -Maximum ([int]::MaxValue)) -or
                $Document.controllerStartTimeUtc -isnot [string] -or
                [string]::CompareOrdinal($Document.launchAttemptedAtUtc, $Document.controllerStartTimeUtc) -gt 0 -or
                [string]::CompareOrdinal($Document.controllerStartTimeUtc, $Document.controllerStartedAtUtc) -gt 0) { return $false }
        } elseif (@($startedValues | Where-Object { $null -ne $_ }).Count -ne 0) { return $false }
        foreach ($timestamp in @($Document.controllerStartedAtUtc, $Document.controllerStartTimeUtc, $Document.captureCompletedAtUtc, $Document.controllerExitedAtUtc)) {
            if ($null -ne $timestamp -and [string]::CompareOrdinal($timestamp, $Document.recordedAtUtc) -gt 0) { return $false }
        }
        $captureComplete = $Document.stdoutEof -and $Document.stderrEof
        if (($null -ne $Document.captureCompletedAtUtc) -ne $captureComplete -or
            ($captureComplete -and [string]::CompareOrdinal($Document.controllerStartedAtUtc, $Document.captureCompletedAtUtc) -gt 0)) { return $false }
        $settledShape = $null -ne $Document.controllerExitCode -and $null -ne $Document.controllerExitedAtUtc
        if ($Document.processSettled -ne $settledShape -or
            (($null -ne $Document.controllerExitCode) -ne ($null -ne $Document.controllerExitedAtUtc)) -or
            ($Document.processSettled -and (-not $started -or
                [string]::CompareOrdinal($Document.controllerStartTimeUtc, $Document.controllerExitedAtUtc) -gt 0))) { return $false }

        if ($category -ceq 'launch-failed') {
            return -not $started -and $null -eq $Document.captureCompletedAtUtc -and $null -eq $Document.controllerExitedAtUtc -and
                $null -eq $Document.controllerExitCode -and $Document.stdoutBytes -eq 0 -and $Document.stderrBytes -eq 0 -and
                -not $Document.stdoutEof -and -not $Document.stderrEof -and -not $Document.processSettled
        }
        if ($category -ceq 'settlement-invalid' -and -not $started) {
            return $null -eq $Document.captureCompletedAtUtc -and $null -eq $Document.controllerExitedAtUtc -and
                $null -eq $Document.controllerExitCode -and $Document.stdoutBytes -eq 0 -and $Document.stderrBytes -eq 0 -and
                -not $Document.stdoutEof -and -not $Document.stderrEof -and -not $Document.processSettled
        }
        if (-not $started) { return $false }
        switch -CaseSensitive ($category) {
            'none' { return $captureComplete -and -not $Document.stdoutOverflow -and -not $Document.stderrOverflow -and $Document.processSettled }
            'capture-overflow' { return $captureComplete -and ($Document.stdoutOverflow -or $Document.stderrOverflow) -and $Document.processSettled }
            'capture-invalid' { return $Document.processSettled -and -not ($captureComplete -and ($Document.stdoutOverflow -or $Document.stderrOverflow)) }
            'settlement-invalid' { return -not $Document.processSettled }
            'consumption-journal-invalid' { return $true }
        }
        return $false
    } catch { return $false }
}

function Test-IntentArcPreflightClosedInteger {
    param($Value, [long] $Minimum, [long] $Maximum)
    return ($Value -is [int] -or $Value -is [long]) -and [long]$Value -ge $Minimum -and [long]$Value -le $Maximum
}

function Test-IntentArcId06Timestamp {
    param($Value)
    if ($Value -isnot [string] -or $Value -cnotmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$') { return $false }
    $parsed = [DateTime]::MinValue
    return [DateTime]::TryParseExact($Value, "yyyy-MM-ddTHH:mm:ss.fffffff'Z'", [Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal, [ref]$parsed)
}

function Test-IntentArcPreflightConsumption {
    param([Parameter(Mandatory)] $Document, [Parameter(Mandatory)] $AuthorizationSha256)
    try {
        $keys = @('schema', 'attemptId', 'authorizationSha256', 'consumedAtUtc', 'controllerLaunchStatus')
        return (Test-IntentArcPreflightExecutionExactPropertyNames -Value $Document -Expected $keys) -and
            (Test-IntentArcPreflightExecutionFixedText -Actual $Document.schema -Expected 'intentarc.preflight-execution-consumed/v1') -and
            (Test-IntentArcPreflightExecutionFixedText -Actual $Document.attemptId -Expected $script:IntentArcPreflightExecutionAttemptId) -and
            $AuthorizationSha256 -is [string] -and $AuthorizationSha256 -cmatch '^[0-9a-f]{64}$' -and
            (Test-IntentArcPreflightExecutionFixedText -Actual $Document.authorizationSha256 -Expected $AuthorizationSha256) -and
            (Test-IntentArcPreflightExecutionCanonicalTimestamp $Document.consumedAtUtc) -and
            (Test-IntentArcPreflightExecutionFixedText -Actual $Document.controllerLaunchStatus -Expected 'attempted')
    } catch { return $false }
}

function Test-IntentArcPreflightControllerStarted {
    param(
        [Parameter(Mandatory)] $Document,
        [Parameter(Mandatory)] $AuthorizationSha256,
        [Parameter(Mandatory)] $ConsumedSha256
    )
    try {
        $keys = @('schema', 'attemptId', 'controllerRunId', 'authorizationSha256', 'consumedSha256',
            'controllerProcessId', 'controllerStartTimeUtc', 'recordedAtUtc')
        if (-not (Test-IntentArcPreflightExecutionExactPropertyNames -Value $Document -Expected $keys) -or
            -not (Test-IntentArcPreflightExecutionFixedText -Actual $Document.schema -Expected 'intentarc.preflight-execution-controller-started/v1') -or
            -not (Test-IntentArcPreflightExecutionFixedText -Actual $Document.attemptId -Expected $script:IntentArcPreflightExecutionAttemptId) -or
            -not (Test-IntentArcPreflightExecutionFixedText -Actual $Document.controllerRunId -Expected $script:IntentArcPreflightExecutionControllerRunId) -or
            $AuthorizationSha256 -isnot [string] -or $AuthorizationSha256 -cnotmatch '^[0-9a-f]{64}$' -or
            $ConsumedSha256 -isnot [string] -or $ConsumedSha256 -cnotmatch '^[0-9a-f]{64}$' -or
            -not (Test-IntentArcPreflightExecutionFixedText -Actual $Document.authorizationSha256 -Expected $AuthorizationSha256) -or
            -not (Test-IntentArcPreflightExecutionFixedText -Actual $Document.consumedSha256 -Expected $ConsumedSha256) -or
            -not (Test-IntentArcPreflightClosedInteger -Value $Document.controllerProcessId -Minimum 1 -Maximum ([int]::MaxValue)) -or
            -not (Test-IntentArcPreflightExecutionCanonicalTimestamp $Document.controllerStartTimeUtc) -or
            -not (Test-IntentArcPreflightExecutionCanonicalTimestamp $Document.recordedAtUtc)) { return $false }
        return [string]::CompareOrdinal($Document.controllerStartTimeUtc, $Document.recordedAtUtc) -le 0
    } catch { return $false }
}

function Test-IntentArcId06ResultV2 {
    param([Parameter(Mandatory)] $Document)
    try {
        $keys = @('schema', 'status', 'category', 'cleanupCategory', 'phase', 'childStarted', 'childExitCode', 'outRestored')
        $statuses = @('PASS', 'RECOVERED', 'REFUSED', 'FAIL')
        $categories = @('none', 'recovery-restored', 'arguments-invalid', 'repository-invalid', 'preflight-id-used',
            'out-source-invalid', 'preservation-state-invalid', 'state-evidence-invalid', 'pnpm-binding-invalid',
            'out-preservation-failed', 'preflight-start-failed', 'preflight-failed', 'preflight-timeout',
            'preflight-canceled', 'child-settlement-failed', 'out-restoration-conflict', 'out-restoration-failed',
            'receipt-invalid', 'residue-invalid')
        $phases = @('validated', 'prepared', 'preserved', 'child-started', 'child-settled', 'restored', 'complete')
        if (-not (Test-IntentArcPreflightExecutionExactPropertyNames -Value $Document -Expected $keys) -or
            -not (Test-IntentArcPreflightExecutionFixedText -Actual $Document.schema -Expected 'intentarc.preflight-out-preservation-result/v2') -or
            $Document.status -isnot [string] -or $statuses -cnotcontains $Document.status -or
            $Document.category -isnot [string] -or $categories -cnotcontains $Document.category -or
            $Document.cleanupCategory -isnot [string] -or @('none', 'residue-invalid') -cnotcontains $Document.cleanupCategory -or
            $Document.phase -isnot [string] -or $phases -cnotcontains $Document.phase -or
            $Document.childStarted -isnot [bool] -or $Document.outRestored -isnot [bool] -or
            ($null -ne $Document.childExitCode -and -not (Test-IntentArcPreflightClosedInteger -Value $Document.childExitCode -Minimum ([int]::MinValue) -Maximum ([int]::MaxValue))) -or
            ($Document.cleanupCategory -ceq 'residue-invalid' -and $Document.phase -cne 'complete' -and
                -not ($Document.category -ceq 'state-evidence-invalid' -and $Document.phase -ceq 'restored'))) { return $false }
        switch -CaseSensitive ($Document.status) {
            'PASS' {
                return $Document.category -ceq 'none' -and $Document.cleanupCategory -ceq 'none' -and
                    $Document.phase -ceq 'complete' -and $Document.childStarted -and $Document.childExitCode -eq 0 -and $Document.outRestored
            }
            'RECOVERED' {
                return $Document.category -ceq 'recovery-restored' -and $Document.phase -ceq 'complete' -and
                    -not $Document.childStarted -and $null -eq $Document.childExitCode -and $Document.outRestored
            }
            'REFUSED' {
                return @('arguments-invalid', 'repository-invalid', 'preflight-id-used', 'out-source-invalid',
                    'preservation-state-invalid', 'pnpm-binding-invalid') -ccontains $Document.category -and
                    $Document.cleanupCategory -ceq 'none' -and $Document.phase -ceq 'validated' -and
                    -not $Document.childStarted -and $null -eq $Document.childExitCode -and -not $Document.outRestored
            }
            'FAIL' {
                switch -CaseSensitive ($Document.category) {
                    'child-settlement-failed' {
                        return @('child-started','child-settled','restored','complete') -ccontains $Document.phase -and
                            $Document.cleanupCategory -ceq 'none' -and (($Document.phase -ceq 'restored' -or $Document.phase -ceq 'complete') -eq $Document.outRestored)
                    }
                    'out-restoration-conflict' { return @('preserved','child-settled') -ccontains $Document.phase -and -not $Document.outRestored -and $Document.cleanupCategory -ceq 'none' }
                    'out-restoration-failed' { return @('preserved','child-settled') -ccontains $Document.phase -and -not $Document.outRestored -and $Document.cleanupCategory -ceq 'none' }
                    'out-preservation-failed' { return @('prepared','preserved') -ccontains $Document.phase -and -not $Document.childStarted -and $null -eq $Document.childExitCode -and $Document.cleanupCategory -ceq 'none' }
                    'repository-invalid' { return @('restored','complete') -ccontains $Document.phase -and $Document.outRestored -and $Document.childStarted -and $Document.childExitCode -eq 0 }
                    'pnpm-binding-invalid' { return @('restored','complete') -ccontains $Document.phase -and $Document.outRestored -and $Document.childStarted -and $Document.childExitCode -eq 0 }
                    'preflight-start-failed' { return @('restored','complete') -ccontains $Document.phase -and $Document.outRestored -and -not $Document.childStarted -and $null -eq $Document.childExitCode }
                    'preflight-failed' { return @('restored','complete') -ccontains $Document.phase -and $Document.outRestored -and $Document.childStarted }
                    'preflight-timeout' { return @('restored','complete') -ccontains $Document.phase -and $Document.outRestored -and $Document.childStarted -and $null -eq $Document.childExitCode }
                    'preflight-canceled' { return @('restored','complete') -ccontains $Document.phase -and $Document.outRestored -and $null -eq $Document.childExitCode }
                    'receipt-invalid' { return @('restored','complete') -ccontains $Document.phase -and $Document.outRestored -and $Document.childStarted -and $Document.childExitCode -eq 0 }
                    'residue-invalid' { return $Document.phase -ceq 'complete' -and $Document.outRestored -and $Document.childStarted -and $Document.childExitCode -eq 0 -and $Document.cleanupCategory -ceq 'residue-invalid' }
                    'state-evidence-invalid' {
                        if (-not $Document.childStarted -and $null -ne $Document.childExitCode) { return $false }
                        switch -CaseSensitive ($Document.phase) {
                            'validated' {
                                return -not $Document.childStarted -and $null -eq $Document.childExitCode -and
                                    -not $Document.outRestored -and $Document.cleanupCategory -ceq 'none'
                            }
                            'prepared' {
                                return -not $Document.childStarted -and $null -eq $Document.childExitCode -and
                                    $Document.cleanupCategory -ceq 'none'
                            }
                            'preserved' {
                                return -not $Document.childStarted -and $null -eq $Document.childExitCode -and
                                    $Document.cleanupCategory -ceq 'none'
                            }
                            'child-started' { return (-not $Document.childStarted -or $Document.outRestored) -and $Document.cleanupCategory -ceq 'none' }
                            'child-settled' { return (-not $Document.childStarted -or $Document.outRestored) -and $Document.cleanupCategory -ceq 'none' }
                            'restored' { return $Document.outRestored }
                        }
                        return $false
                    }
                }
                return $false
            }
        }
        return $false
    } catch { return $false }
}

function Test-IntentArcId06ReceiptIdentity {
    param([Parameter(Mandatory)] $Identity)
    try {
        if (-not (Test-IntentArcPreflightExecutionExactPropertyNames -Value $Identity -Expected @('before', 'after', 'unchanged')) -or
            $Identity.before -isnot [string] -or $Identity.before -cnotmatch '^[a-f0-9]{64}$' -or
            ($null -ne $Identity.after -and ($Identity.after -isnot [string] -or $Identity.after -cnotmatch '^[a-f0-9]{64}$')) -or
            ($null -ne $Identity.unchanged -and $Identity.unchanged -isnot [bool])) { return $false }
        if ($null -ne $Identity.unchanged -and $null -eq $Identity.after) { return $false }
        if ($Identity.unchanged -eq $true -and $Identity.before -cne $Identity.after) { return $false }
        if ($Identity.unchanged -eq $false -and $Identity.before -ceq $Identity.after) { return $false }
        return $true
    } catch { return $false }
}

function Test-IntentArcId06Receipt {
    param([Parameter(Mandatory)] $Document)
    try {
        $keys = @('schemaVersion', 'runId', 'status', 'failureCategory', 'checks', 'git', 'source', 'packageJson', 'vendor', 'out')
        $checkIds = @('focused-tests', 'server-typecheck', 'web-typecheck', 'adapter-strict')
        $checkStates = @('pending', 'running', 'passed', 'failed')
        $failureCategories = @('initial-evidence', 'focused-tests', 'server-typecheck', 'web-typecheck', 'adapter-strict', 'git-gates', 'final-evidence', 'receipt-write')
        if (-not (Test-IntentArcPreflightExecutionExactPropertyNames -Value $Document -Expected $keys) -or
            $Document.schemaVersion -isnot [int] -or $Document.schemaVersion -ne 2 -or
            -not (Test-IntentArcPreflightExecutionFixedText -Actual $Document.runId -Expected $script:IntentArcPreflightExecutionControllerRunId) -or
            $Document.status -isnot [string] -or @('running', 'passed', 'failed') -cnotcontains $Document.status -or
            ($null -ne $Document.failureCategory -and ($Document.failureCategory -isnot [string] -or $failureCategories -cnotcontains $Document.failureCategory)) -or
            -not (Test-IntentArcPreflightExecutionExactPropertyNames -Value $Document.checks -Expected $checkIds)) { return $false }
        foreach ($id in $checkIds) { if ($Document.checks.$id -isnot [string] -or $checkStates -cnotcontains $Document.checks.$id) { return $false } }
        if (-not (Test-IntentArcPreflightExecutionExactPropertyNames -Value $Document.git -Expected @('statusScope', 'diffCheckPassed', 'productDiffClean', 'statusClean', 'statusEntryCount')) -or
            -not (Test-IntentArcPreflightExecutionFixedText -Actual $Document.git.statusScope -Expected 'tracked-only')) { return $false }
        foreach ($name in @('diffCheckPassed', 'productDiffClean', 'statusClean')) {
            if ($null -ne $Document.git.$name -and $Document.git.$name -isnot [bool]) { return $false }
        }
        if ($null -ne $Document.git.statusEntryCount -and -not (Test-IntentArcPreflightClosedInteger -Value $Document.git.statusEntryCount -Minimum 0 -Maximum 1000000)) { return $false }
        if (-not (Test-IntentArcId06ReceiptIdentity $Document.source) -or -not (Test-IntentArcId06ReceiptIdentity $Document.packageJson) -or
            -not (Test-IntentArcId06ReceiptIdentity $Document.vendor) -or
            -not (Test-IntentArcPreflightExecutionExactPropertyNames -Value $Document.out -Expected @('absentBefore', 'absentAfter')) -or
            $Document.out.absentBefore -isnot [bool] -or ($null -ne $Document.out.absentAfter -and $Document.out.absentAfter -isnot [bool])) { return $false }
        if (($Document.status -ceq 'running' -or $Document.status -ceq 'passed') -and $null -ne $Document.failureCategory) { return $false }
        if ($Document.status -ceq 'failed' -and $null -eq $Document.failureCategory) { return $false }
        if ($Document.status -ceq 'passed') {
            foreach ($id in $checkIds) { if ($Document.checks.$id -cne 'passed') { return $false } }
            if ($Document.git.diffCheckPassed -ne $true -or $Document.git.productDiffClean -ne $true -or
                $Document.git.statusClean -ne $true -or $Document.git.statusEntryCount -ne 0 -or
                $Document.source.unchanged -ne $true -or $Document.packageJson.unchanged -ne $true -or
                $Document.vendor.unchanged -ne $true -or $Document.out.absentBefore -ne $true -or $Document.out.absentAfter -ne $true) { return $false }
        }
        return $true
    } catch { return $false }
}

function Test-IntentArcId06OwnedRoot {
    param([Parameter(Mandatory)] $Value, [Parameter(Mandatory)][string] $ExpectedPath)
    try {
        return (Test-IntentArcPreflightExecutionExactPropertyNames -Value $Value -Expected @('canonicalPath', 'attributes', 'stableIdentity')) -and
            $Value.canonicalPath -is [string] -and [string]::Equals($Value.canonicalPath, $ExpectedPath, [StringComparison]::OrdinalIgnoreCase) -and
            $Value.attributes -is [int] -and (($Value.attributes -band [int][IO.FileAttributes]::Directory) -ne 0) -and
            (($Value.attributes -band [int][IO.FileAttributes]::ReparsePoint) -eq 0) -and
            $Value.stableIdentity -is [string] -and $Value.stableIdentity -cmatch '^[a-f0-9]{8}:[a-f0-9]{16}$'
    } catch { return $false }
}

function Test-IntentArcId06Recovery {
    param([Parameter(Mandatory)] $Recovery, [Parameter(Mandatory)][string] $Phase)
    try {
        if (-not (Test-IntentArcPreflightExecutionExactPropertyNames -Value $Recovery -Expected @('mode', 'sourcePhase', 'settlementProvenAt')) -or
            $Recovery.mode -isnot [string] -or @('none', 'restore-only') -cnotcontains $Recovery.mode -or
            ($null -ne $Recovery.sourcePhase -and $Recovery.sourcePhase -isnot [string]) -or
            ($null -ne $Recovery.settlementProvenAt -and -not (Test-IntentArcId06Timestamp $Recovery.settlementProvenAt))) { return $false }
        if ($Recovery.mode -ceq 'none') { return $null -eq $Recovery.sourcePhase -and $null -eq $Recovery.settlementProvenAt }
        return @('prepared', 'preserved', 'child-started', 'child-settled') -ccontains $Recovery.sourcePhase -and
            $null -ne $Recovery.settlementProvenAt -and ($Phase -ceq $Recovery.sourcePhase -or @('restored', 'complete') -ccontains $Phase)
    } catch { return $false }
}

function Test-IntentArcId06Child {
    param([Parameter(Mandatory)] $Child, [Parameter(Mandatory)][string] $Phase, [Parameter(Mandatory)] $Recovery)
    try {
        $keys = @('jobName', 'rootProcessId', 'rootStartTimeUtc', 'assignmentStatus', 'settlementStatus', 'terminationReason',
            'exitCode', 'stdoutBytes', 'stderrBytes', 'outputOverflow', 'timedOut', 'canceled', 'infrastructureFailure')
        if (-not (Test-IntentArcPreflightExecutionExactPropertyNames -Value $Child -Expected $keys) -or
            -not (Test-IntentArcPreflightExecutionFixedText -Actual $Child.jobName -Expected ('IntentArc.Preflight.' + $script:IntentArcPreflightExecutionControllerRunId)) -or
            ($null -ne $Child.rootProcessId -and -not (Test-IntentArcPreflightClosedInteger -Value $Child.rootProcessId -Minimum 1 -Maximum ([int]::MaxValue))) -or
            ($null -ne $Child.rootStartTimeUtc -and -not (Test-IntentArcId06Timestamp $Child.rootStartTimeUtc)) -or
            $Child.assignmentStatus -isnot [string] -or @('not-attempted', 'attempted', 'assigned', 'unknown') -cnotcontains $Child.assignmentStatus -or
            $Child.settlementStatus -isnot [string] -or @('not-started', 'unsettled', 'settled') -cnotcontains $Child.settlementStatus -or
            $Child.terminationReason -isnot [string] -or @('not-started', 'normal-exit', 'output-overflow', 'timeout', 'canceled', 'infrastructure-failure', 'settlement-failed', 'unknown') -cnotcontains $Child.terminationReason -or
            ($null -ne $Child.exitCode -and -not (Test-IntentArcPreflightClosedInteger -Value $Child.exitCode -Minimum ([int]::MinValue) -Maximum ([int]::MaxValue))) -or
            -not (Test-IntentArcPreflightClosedInteger -Value $Child.stdoutBytes -Minimum 0 -Maximum 9007199254740991) -or
            -not (Test-IntentArcPreflightClosedInteger -Value $Child.stderrBytes -Minimum 0 -Maximum 9007199254740991)) { return $false }
        foreach ($name in @('outputOverflow', 'timedOut', 'canceled', 'infrastructureFailure')) { if ($Child.$name -isnot [bool]) { return $false } }
        if ($Child.outputOverflow -ne ($Child.stdoutBytes -gt 1048576 -or $Child.stderrBytes -gt 1048576)) { return $false }
        $identity = $null -ne $Child.rootProcessId
        if ($identity -ne ($null -ne $Child.rootStartTimeUtc)) { return $false }
        $effectivePhase = $Phase
        if ($Recovery.mode -ceq 'restore-only') { $effectivePhase = $Recovery.sourcePhase }
        elseif (@('restored', 'complete') -ccontains $Phase) { $effectivePhase = 'child-settled' }
        $flagsFalse = -not $Child.outputOverflow -and -not $Child.timedOut -and -not $Child.canceled -and -not $Child.infrastructureFailure
        if (@('prepared', 'preserved') -ccontains $effectivePhase) {
            return $Child.assignmentStatus -ceq 'not-attempted' -and $Child.settlementStatus -ceq 'not-started' -and -not $identity -and
                $Child.terminationReason -ceq 'not-started' -and $null -eq $Child.exitCode -and $Child.stdoutBytes -eq 0 -and $Child.stderrBytes -eq 0 -and $flagsFalse
        }
        if ($effectivePhase -ceq 'child-started') {
            return $Child.assignmentStatus -ceq 'attempted' -and $Child.settlementStatus -ceq 'unsettled' -and -not $identity -and
                $Child.terminationReason -ceq 'unknown' -and $null -eq $Child.exitCode -and $Child.stdoutBytes -eq 0 -and $Child.stderrBytes -eq 0 -and $flagsFalse
        }
        if ($effectivePhase -cne 'child-settled') { return $false }
        switch -CaseSensitive ($Child.terminationReason) {
            'normal-exit' { return $Child.assignmentStatus -ceq 'assigned' -and $Child.settlementStatus -ceq 'settled' -and $identity -and $null -ne $Child.exitCode -and $flagsFalse }
            'output-overflow' { return $Child.assignmentStatus -ceq 'assigned' -and $Child.settlementStatus -ceq 'settled' -and $identity -and $null -eq $Child.exitCode -and ($Child.stdoutBytes -gt 1048576 -or $Child.stderrBytes -gt 1048576) -and $Child.outputOverflow -and -not $Child.timedOut -and -not $Child.canceled -and -not $Child.infrastructureFailure }
            'timeout' { return $Child.assignmentStatus -ceq 'assigned' -and $Child.settlementStatus -ceq 'settled' -and $identity -and $null -eq $Child.exitCode -and -not $Child.outputOverflow -and $Child.timedOut -and -not $Child.canceled -and -not $Child.infrastructureFailure }
            'canceled' { return (($Child.assignmentStatus -ceq 'attempted' -and -not $identity) -or ($Child.assignmentStatus -ceq 'assigned' -and $identity)) -and $Child.settlementStatus -ceq 'settled' -and $null -eq $Child.exitCode -and -not $Child.outputOverflow -and -not $Child.timedOut -and $Child.canceled -and -not $Child.infrastructureFailure }
            'infrastructure-failure' { return (($Child.assignmentStatus -ceq 'attempted' -and -not $identity) -or ($Child.assignmentStatus -ceq 'assigned' -and $identity)) -and $Child.settlementStatus -ceq 'settled' -and ($null -eq $Child.exitCode -or ($Child.assignmentStatus -ceq 'assigned' -and $null -ne $Child.exitCode)) -and -not $Child.outputOverflow -and -not $Child.timedOut -and -not $Child.canceled -and $Child.infrastructureFailure }
            'settlement-failed' { return (($Child.assignmentStatus -ceq 'attempted' -and -not $identity) -or ($Child.assignmentStatus -ceq 'assigned' -and $identity) -or ($Child.assignmentStatus -ceq 'unknown')) -and $Child.settlementStatus -ceq 'unsettled' -and $Child.infrastructureFailure }
        }
        return $false
    } catch { return $false }
}

function Test-IntentArcId06Cleanup {
    param([Parameter(Mandatory)] $Cleanup, [Parameter(Mandatory)][string] $Phase)
    try {
        if (-not (Test-IntentArcPreflightExecutionExactPropertyNames -Value $Cleanup -Expected @('localAppDataStatus', 'profileStatus', 'runRootStatus', 'category'))) { return $false }
        foreach ($name in @('localAppDataStatus', 'profileStatus', 'runRootStatus')) {
            if ($Cleanup.$name -isnot [string] -or @('pending', 'removed', 'retained', 'invalid') -cnotcontains $Cleanup.$name) { return $false }
        }
        if ($Cleanup.category -isnot [string] -or @('none', 'residue-invalid') -cnotcontains $Cleanup.category) { return $false }
        if ($Phase -cne 'complete') { return $Cleanup.localAppDataStatus -ceq 'pending' -and $Cleanup.profileStatus -ceq 'pending' -and $Cleanup.runRootStatus -ceq 'pending' -and $Cleanup.category -ceq 'none' }
        if (@($Cleanup.localAppDataStatus, $Cleanup.profileStatus, $Cleanup.runRootStatus) -ccontains 'pending') { return $false }
        $allRemoved = $Cleanup.localAppDataStatus -ceq 'removed' -and $Cleanup.profileStatus -ceq 'removed' -and $Cleanup.runRootStatus -ceq 'removed'
        if ($Cleanup.runRootStatus -ceq 'removed' -and ($Cleanup.localAppDataStatus -cne 'removed' -or $Cleanup.profileStatus -cne 'removed')) { return $false }
        return ($allRemoved -and $Cleanup.category -ceq 'none') -or (-not $allRemoved -and $Cleanup.category -ceq 'residue-invalid')
    } catch { return $false }
}

function Test-IntentArcId06Timestamps {
    param([Parameter(Mandatory)] $Timestamps, [Parameter(Mandatory)][string] $Phase, [Parameter(Mandatory)] $Recovery)
    try {
        $names = @('preparedAt', 'preservedAt', 'childStartedAt', 'childSettledAt', 'restoredAt', 'completedAt')
        if (-not (Test-IntentArcPreflightExecutionExactPropertyNames -Value $Timestamps -Expected $names)) { return $false }
        foreach ($name in $names) { if ($null -ne $Timestamps.$name -and -not (Test-IntentArcId06Timestamp $Timestamps.$name)) { return $false } }
        $originalPhase = if ($Recovery.mode -ceq 'restore-only') { $Recovery.sourcePhase } else { $Phase }
        $matrix = @{ prepared=@($true,$false,$false,$false); preserved=@($true,$true,$false,$false); 'child-started'=@($true,$true,$true,$false); 'child-settled'=@($true,$true,$true,$true); restored=@($true,$true,$true,$true); complete=@($true,$true,$true,$true) }
        $required = @($matrix[$originalPhase]); if ($required.Count -ne 4) { return $false }
        for ($index=0; $index -lt 4; $index++) { if ($required[$index] -ne ($null -ne $Timestamps.($names[$index]))) { return $false } }
        if ((@('restored','complete') -ccontains $Phase) -ne ($null -ne $Timestamps.restoredAt) -or ($Phase -ceq 'complete') -ne ($null -ne $Timestamps.completedAt)) { return $false }
        $last = [DateTime]::MinValue; $lastOriginal = [DateTime]::MinValue
        for ($index=0; $index -lt $names.Count; $index++) {
            $value=$Timestamps.($names[$index]); if ($null -eq $value) { continue }
            $parsed=[DateTime]::ParseExact($value,"yyyy-MM-ddTHH:mm:ss.fffffff'Z'",[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::AssumeUniversal).ToUniversalTime()
            if ($parsed -lt $last) { return $false }; $last=$parsed; if($index -lt 4){$lastOriginal=$parsed}
        }
        if ($Recovery.mode -ceq 'restore-only') {
            $proof=[DateTime]::ParseExact($Recovery.settlementProvenAt,"yyyy-MM-ddTHH:mm:ss.fffffff'Z'",[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::AssumeUniversal).ToUniversalTime()
            if($proof -lt $lastOriginal){return $false}
            if($null -ne $Timestamps.restoredAt){$restored=[DateTime]::ParseExact($Timestamps.restoredAt,"yyyy-MM-ddTHH:mm:ss.fffffff'Z'",[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::AssumeUniversal).ToUniversalTime();if($restored -lt $proof){return $false}}
        }
        return $true
    } catch { return $false }
}

function Test-IntentArcId06StateV2 {
    param(
        [Parameter(Mandatory)] $Document, [Parameter(Mandatory)] $ExpectedCommit,
        [Parameter(Mandatory)] $PnpmPath, [Parameter(Mandatory)] $PnpmSha256,
        [Parameter(Mandatory)] $SourcePath, [Parameter(Mandatory)] $DestinationPath,
        [Parameter(Mandatory)] $ProfilePath, [Parameter(Mandatory)] $LocalAppDataPath
    )
    try {
        foreach($text in @($ExpectedCommit,$PnpmPath,$PnpmSha256,$SourcePath,$DestinationPath,$ProfilePath,$LocalAppDataPath)){
            if($text-isnot[string]){return $false}
        }
        foreach($path in @($PnpmPath,$SourcePath,$DestinationPath,$ProfilePath,$LocalAppDataPath)){
            if(-not(Test-IntentArcPreflightExecutionFullyQualifiedWindowsPath $path)){return $false}
        }
        if(-not[string]::Equals([IO.Path]::GetFileName($PnpmPath),'pnpm.exe',[StringComparison]::OrdinalIgnoreCase)-or
            -not[string]::Equals([IO.Path]::GetFileName($SourcePath),'out',[StringComparison]::OrdinalIgnoreCase)){return $false}
        $repositoryRoot=[IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($SourcePath))
        $runRoot=Join-Path (Join-Path $repositoryRoot '.superpowers\preflight-out-preservation') $script:IntentArcPreflightExecutionControllerRunId
        if(-not[string]::Equals([IO.Path]::GetFullPath($DestinationPath),(Join-Path $runRoot 'out'),[StringComparison]::OrdinalIgnoreCase)-or
            -not[string]::Equals([IO.Path]::GetFullPath($ProfilePath),(Join-Path $runRoot 'profile'),[StringComparison]::OrdinalIgnoreCase)-or
            -not[string]::Equals([IO.Path]::GetFullPath($LocalAppDataPath),(Join-Path $runRoot 'localappdata'),[StringComparison]::OrdinalIgnoreCase)){return $false}
        $keys=@('schema','sourcePath','destinationPath','runId','expectedCommit','directory','ownedRoots','pnpm','child','recovery','cleanup','timestamps','phase')
        if(-not(Test-IntentArcPreflightExecutionExactPropertyNames -Value $Document -Expected $keys)-or
            -not(Test-IntentArcPreflightExecutionFixedText -Actual $Document.schema -Expected 'intentarc.preflight-out-preservation-state/v2')-or
            $Document.sourcePath-isnot[string]-or-not[string]::Equals($Document.sourcePath,$SourcePath,[StringComparison]::OrdinalIgnoreCase)-or
            $Document.destinationPath-isnot[string]-or-not[string]::Equals($Document.destinationPath,$DestinationPath,[StringComparison]::OrdinalIgnoreCase)-or
            -not(Test-IntentArcPreflightExecutionFixedText -Actual $Document.runId -Expected $script:IntentArcPreflightExecutionControllerRunId)-or
            $ExpectedCommit-cnotmatch'^[a-f0-9]{40}$'-or-not(Test-IntentArcPreflightExecutionFixedText -Actual $Document.expectedCommit -Expected $ExpectedCommit)-or
            $Document.phase-isnot[string]-or@('prepared','preserved','child-started','child-settled','restored','complete')-cnotcontains$Document.phase){return $false}
        if(-not(Test-IntentArcPreflightExecutionExactPropertyNames -Value $Document.directory -Expected @('canonicalPath','attributes','creationTimeUtc','lastWriteTimeUtc','stableIdentity'))-or
            $Document.directory.canonicalPath-isnot[string]-or-not[string]::Equals($Document.directory.canonicalPath,$SourcePath,[StringComparison]::OrdinalIgnoreCase)-or
            $Document.directory.attributes-isnot[int]-or(($Document.directory.attributes-band[int][IO.FileAttributes]::Directory)-eq0)-or(($Document.directory.attributes-band[int][IO.FileAttributes]::ReparsePoint)-ne0)-or
            -not(Test-IntentArcId06Timestamp $Document.directory.creationTimeUtc)-or-not(Test-IntentArcId06Timestamp $Document.directory.lastWriteTimeUtc)-or
            $Document.directory.stableIdentity-isnot[string]-or$Document.directory.stableIdentity-cnotmatch'^[a-f0-9]{8}:[a-f0-9]{16}$'){return $false}
        if(-not(Test-IntentArcPreflightExecutionExactPropertyNames -Value $Document.ownedRoots -Expected @('profile','localAppData'))-or
            -not(Test-IntentArcId06OwnedRoot -Value $Document.ownedRoots.profile -ExpectedPath $ProfilePath)-or
            -not(Test-IntentArcId06OwnedRoot -Value $Document.ownedRoots.localAppData -ExpectedPath $LocalAppDataPath)){return $false}
        if(-not(Test-IntentArcPreflightExecutionExactPropertyNames -Value $Document.pnpm -Expected @('path','sha256'))-or
            $Document.pnpm.path-isnot[string]-or-not[string]::Equals($Document.pnpm.path,$PnpmPath,[StringComparison]::OrdinalIgnoreCase)-or
            $PnpmSha256-cnotmatch'^[a-f0-9]{64}$'-or-not(Test-IntentArcPreflightExecutionFixedText -Actual $Document.pnpm.sha256 -Expected $PnpmSha256)){return $false}
        return (Test-IntentArcId06Recovery -Recovery $Document.recovery -Phase $Document.phase)-and
            (Test-IntentArcId06Child -Child $Document.child -Phase $Document.phase -Recovery $Document.recovery)-and
            (Test-IntentArcId06Cleanup -Cleanup $Document.cleanup -Phase $Document.phase)-and
            (Test-IntentArcId06Timestamps -Timestamps $Document.timestamps -Phase $Document.phase -Recovery $Document.recovery)
    }catch{return $false}
}

function Test-IntentArcId06CandidateSuccess {
    param(
        [Parameter(Mandatory)]$Result,[Parameter(Mandatory)]$State,[Parameter(Mandatory)]$Receipt,
        [Parameter(Mandatory)]$ExpectedCommit,[Parameter(Mandatory)]$PnpmPath,[Parameter(Mandatory)]$PnpmSha256,
        [Parameter(Mandatory)]$SourcePath,[Parameter(Mandatory)]$DestinationPath,
        [Parameter(Mandatory)]$ProfilePath,[Parameter(Mandatory)]$LocalAppDataPath
    )
    try {
        return (Test-IntentArcId06ResultV2 $Result)-and(Test-IntentArcId06StateV2 -Document $State -ExpectedCommit $ExpectedCommit -PnpmPath $PnpmPath -PnpmSha256 $PnpmSha256 -SourcePath $SourcePath -DestinationPath $DestinationPath -ProfilePath $ProfilePath -LocalAppDataPath $LocalAppDataPath)-and
            (Test-IntentArcId06Receipt $Receipt)-and$Result.status-ceq'PASS'-and$Result.category-ceq'none'-and$Result.cleanupCategory-ceq'none'-and$Result.phase-ceq'complete'-and$Result.childStarted-and$Result.childExitCode-eq0-and$Result.outRestored-and
            $State.phase-ceq'complete'-and$State.recovery.mode-ceq'none'-and$State.child.assignmentStatus-ceq'assigned'-and$State.child.settlementStatus-ceq'settled'-and$State.child.terminationReason-ceq'normal-exit'-and$State.child.exitCode-eq0-and
            $State.cleanup.localAppDataStatus-ceq'removed'-and$State.cleanup.profileStatus-ceq'removed'-and$State.cleanup.runRootStatus-ceq'removed'-and$State.cleanup.category-ceq'none'-and$Receipt.status-ceq'passed'
    }catch{return $false}
}

function Test-IntentArcPreflightAuditResult {
    param([Parameter(Mandatory)]$Document)
    try {
        $keys=@('schema','status','category','attemptId','controllerRunId','expectedCommit','attemptConsumed','controllerStarted','controllerExitCode','resultSha256','stateSha256','receiptSha256','outRestored','cleanupComplete','gitClean','bindingsValid')
        $categories=@('none','authorization-invalid','attempt-not-consumed','attempt-evidence-invalid','controller-not-started','controller-outcome-uncertain','controller-capture-invalid','controller-result-invalid','controller-state-invalid','controller-receipt-invalid','child-settlement-invalid','out-restoration-invalid','cleanup-invalid','repository-invalid','binding-invalid','audit-infrastructure-invalid')
        if(-not(Test-IntentArcPreflightEnvelopeOrderedPropertyNames -Value $Document -Expected $keys)-or
            -not(Test-IntentArcPreflightExecutionFixedText -Actual $Document.schema -Expected 'intentarc.preflight-execution-audit/v1')-or
            $Document.status-isnot[string]-or@('AUDITED-PASS','TERMINAL-NOT-PASS')-cnotcontains$Document.status-or
            $Document.category-isnot[string]-or$categories-cnotcontains$Document.category-or
            -not(Test-IntentArcPreflightExecutionFixedText -Actual $Document.attemptId -Expected $script:IntentArcPreflightExecutionAttemptId)-or
            -not(Test-IntentArcPreflightExecutionFixedText -Actual $Document.controllerRunId -Expected $script:IntentArcPreflightExecutionControllerRunId)){return $false}
        if($null-ne$Document.expectedCommit-and($Document.expectedCommit-isnot[string]-or$Document.expectedCommit-cnotmatch'^[a-f0-9]{40}$')){return $false}
        foreach($name in @('attemptConsumed','controllerStarted','outRestored','cleanupComplete','gitClean','bindingsValid')){if($Document.$name-isnot[bool]){return $false}}
        if($null-ne$Document.controllerExitCode-and-not(Test-IntentArcPreflightClosedInteger -Value $Document.controllerExitCode -Minimum ([int]::MinValue) -Maximum ([int]::MaxValue))){return $false}
        foreach($name in @('resultSha256','stateSha256','receiptSha256')){if($null-ne$Document.$name-and($Document.$name-isnot[string]-or$Document.$name-cnotmatch'^[a-f0-9]{64}$')){return $false}}
        $positive=$null-ne$Document.expectedCommit-and$Document.attemptConsumed-and$Document.controllerStarted-and$Document.controllerExitCode-eq0-and
            $null-ne$Document.resultSha256-and$null-ne$Document.stateSha256-and$null-ne$Document.receiptSha256-and$Document.outRestored-and$Document.cleanupComplete-and$Document.gitClean-and$Document.bindingsValid
        if($Document.status-ceq'AUDITED-PASS'){return $Document.category-ceq'none'-and$positive}
        if($Document.category-ceq'none'-or$positive){return $false}
        $commitPresent=$null-ne$Document.expectedCommit
        $exitPresent=$null-ne$Document.controllerExitCode
        $resultPresent=$null-ne$Document.resultSha256
        $statePresent=$null-ne$Document.stateSha256
        $receiptPresent=$null-ne$Document.receiptSha256
        $allDownstreamFalse=-not$Document.outRestored-and-not$Document.cleanupComplete-and-not$Document.gitClean-and-not$Document.bindingsValid
        switch -CaseSensitive($Document.category){
            'authorization-invalid' { return (-not $commitPresent -and -not $Document.attemptConsumed -and -not $Document.controllerStarted -and -not $exitPresent -and -not $resultPresent -and -not $statePresent -and -not $receiptPresent -and $allDownstreamFalse) }
            'attempt-not-consumed' { return ($commitPresent -and -not $Document.attemptConsumed -and -not $Document.controllerStarted -and -not $exitPresent -and -not $resultPresent -and -not $statePresent -and -not $receiptPresent -and $allDownstreamFalse) }
            'attempt-evidence-invalid' { return ($commitPresent -and -not $Document.attemptConsumed -and -not $Document.controllerStarted -and -not $exitPresent -and -not $resultPresent -and -not $statePresent -and -not $receiptPresent -and $allDownstreamFalse) }
            'controller-not-started' { return ($commitPresent -and $Document.attemptConsumed -and -not $Document.controllerStarted -and -not $exitPresent -and -not $resultPresent -and -not $statePresent -and -not $receiptPresent -and $allDownstreamFalse) }
            'controller-outcome-uncertain' { return ($commitPresent -and $Document.attemptConsumed -and -not $exitPresent -and -not $resultPresent -and -not $statePresent -and -not $receiptPresent -and $allDownstreamFalse) }
            'controller-capture-invalid' { return ($commitPresent -and $Document.attemptConsumed -and $Document.controllerStarted -and -not $resultPresent -and -not $statePresent -and -not $receiptPresent -and $allDownstreamFalse) }
            'controller-result-invalid' { return ($commitPresent -and $Document.attemptConsumed -and $Document.controllerStarted -and $exitPresent -and -not $resultPresent -and -not $statePresent -and -not $receiptPresent -and $allDownstreamFalse) }
            'controller-state-invalid' { return ($commitPresent -and $Document.attemptConsumed -and $Document.controllerStarted -and $Document.controllerExitCode -eq 0 -and $resultPresent -and -not $statePresent -and -not $receiptPresent -and $allDownstreamFalse) }
            'controller-receipt-invalid' { return ($commitPresent -and $Document.attemptConsumed -and $Document.controllerStarted -and $Document.controllerExitCode -eq 0 -and $resultPresent -and $statePresent -and -not $receiptPresent -and $allDownstreamFalse) }
            'child-settlement-invalid' { return ($commitPresent -and $Document.attemptConsumed -and $Document.controllerStarted -and $Document.controllerExitCode -eq 0 -and $resultPresent -and $statePresent -and $receiptPresent -and $allDownstreamFalse) }
            'out-restoration-invalid' { return ($commitPresent -and $Document.attemptConsumed -and $Document.controllerStarted -and $Document.controllerExitCode -eq 0 -and $resultPresent -and $statePresent -and $receiptPresent -and $allDownstreamFalse) }
            'cleanup-invalid' { return ($commitPresent -and $Document.attemptConsumed -and $Document.controllerStarted -and $Document.controllerExitCode -eq 0 -and $resultPresent -and $statePresent -and $receiptPresent -and $Document.outRestored -and -not $Document.cleanupComplete -and -not $Document.gitClean -and -not $Document.bindingsValid) }
            'repository-invalid' { return ($commitPresent -and $Document.attemptConsumed -and $Document.controllerStarted -and $Document.controllerExitCode -eq 0 -and $resultPresent -and $statePresent -and $receiptPresent -and $Document.outRestored -and $Document.cleanupComplete -and -not $Document.gitClean -and -not $Document.bindingsValid) }
            'binding-invalid' { return ($commitPresent -and $Document.attemptConsumed -and $Document.controllerStarted -and $Document.controllerExitCode -eq 0 -and $resultPresent -and $statePresent -and $receiptPresent -and $Document.outRestored -and $Document.cleanupComplete -and $Document.gitClean -and -not $Document.bindingsValid) }
            'audit-infrastructure-invalid' { return (-not $Document.attemptConsumed -and -not $Document.controllerStarted -and -not $exitPresent -and -not $resultPresent -and -not $statePresent -and -not $receiptPresent -and $allDownstreamFalse) }
        }
        return $false
    }catch{return $false}
}

function Read-IntentArcClosedJsonDocument {
    param([Parameter(Mandatory)][IntentArc.PreflightEnvelope.BoundaryGuard]$Guard,[Parameter(Mandatory)]$MaximumBytes,[Parameter(Mandatory)]$Schema)
    $maximumBytesByDocument=[ordered]@{consumption=16384;controllerStarted=16384;attemptReceipt=32768;id06Result=65536;id06State=65536;id06Receipt=262144;auditResult=16384}
    if($MaximumBytes-isnot[int]-or$Schema-isnot[string]-or-not$maximumBytesByDocument.Contains($Schema)-or$MaximumBytes-ne[int]$maximumBytesByDocument[$Schema]){throw'controller-document-invalid'}
    try{
        $bytes=[byte[]]$Guard.ReadAllBytes($MaximumBytes)
        if($bytes.Length-lt1-or$bytes.Length-gt$MaximumBytes-or($bytes.Length-ge3-and$bytes[0]-eq0xef-and$bytes[1]-eq0xbb-and$bytes[2]-eq0xbf)){throw'invalid'}
        if(-not[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::ValidateProtection($Guard)){throw'invalid'}
        $sha256=Get-IntentArcPreflightExecutionSha256 -Bytes $bytes
        $text=[Text.UTF8Encoding]::new($false,$true).GetString($bytes)
        $jsonText=$text.TrimEnd([char[]]@(' ',"`t","`r","`n"))
        Assert-IntentArcPreflightExecutionJsonHasNoDuplicateKeys -Text $jsonText
        $document=$jsonText|ConvertFrom-Json -ErrorAction Stop
        if($document-isnot[pscustomobject]){throw'invalid'}
        $valid=switch -CaseSensitive($Schema){
            'consumption'{Test-IntentArcPreflightConsumption $document ([string]$document.authorizationSha256);break}
            'controllerStarted'{Test-IntentArcPreflightControllerStarted $document ([string]$document.authorizationSha256) ([string]$document.consumedSha256);break}
            'attemptReceipt'{Test-IntentArcPreflightAttemptReceipt $document;break}
            'id06Result'{Test-IntentArcId06ResultV2 $document;break}
            'id06State'{Test-IntentArcId06StateV2 -Document $document -ExpectedCommit ([string]$document.expectedCommit) -PnpmPath ([string]$document.pnpm.path) -PnpmSha256 ([string]$document.pnpm.sha256) -SourcePath ([string]$document.sourcePath) -DestinationPath ([string]$document.destinationPath) -ProfilePath ([string]$document.ownedRoots.profile.canonicalPath) -LocalAppDataPath ([string]$document.ownedRoots.localAppData.canonicalPath);break}
            'id06Receipt'{Test-IntentArcId06Receipt $document;break}
            'auditResult'{Test-IntentArcPreflightAuditResult $document;break}
        }
        if($valid-ne$true){throw'invalid'}
        return [pscustomobject][ordered]@{document=$document;bytes=$bytes;sha256=$sha256}
    }catch{throw('controller-'+$Schema+'-invalid')}
}

function Get-IntentArcPreflightExecutionExpectedBinding {
    param([Parameter(Mandatory)] $Contract, [Parameter(Mandatory)][string] $Name)
    if (-not (Test-IntentArcPreflightEnvelopeContract $Contract)) { Throw-IntentArcPreflightExecutionAuthorizationInvalid }
    return [string] $Contract.ExecutableBindings[$Name]
}

function Test-IntentArcPreflightExecutionOuterHostBinding {
    param([Parameter(Mandatory)] $Invocation, [Parameter(Mandatory)] $Contract)
    try {
        if (-not (Test-IntentArcPreflightEnvelopeContract $Contract)) { return $false }
        $metadata = $Invocation.InvocationMetadata
        if ($null -eq $metadata -or $metadata.HostImagePath -isnot [string] -or $metadata.RawCommandLine -isnot [string] -or $metadata.EnvelopePath -isnot [string]) { return $false }
        $hostPath = Get-IntentArcPreflightExecutionExpectedBinding -Contract $Contract -Name 'host'
        $envelopePath = Get-IntentArcPreflightExecutionExpectedBinding -Contract $Contract -Name 'envelope'
        if (-not [string]::Equals($metadata.HostImagePath, $hostPath, [StringComparison]::Ordinal) -or
            -not [string]::Equals($metadata.EnvelopePath, $envelopePath, [StringComparison]::Ordinal)) { return $false }
        $parsed = @(ConvertFrom-IntentArcPreflightExecutionWindowsCommandLine -CommandLine $metadata.RawCommandLine)
        $expected = [string[]] @($hostPath, '-NoProfile', '-NonInteractive', '-File', $envelopePath, ('-' + $Invocation.mode), '-AuthorizationManifest', $Invocation.manifestPath, '-ExpectedAuthorizationSha256', $Invocation.expectedSha256)
        if ($parsed.Count -ne $expected.Count) { return $false }
        for ($index = 0; $index -lt $expected.Count; $index++) {
            if (-not [string]::Equals($parsed[$index], $expected[$index], [StringComparison]::Ordinal)) { return $false }
        }
        $reviewed = @(
            (ConvertTo-IntentArcPreflightExecutionQuotedArgument $hostPath), '-NoProfile', '-NonInteractive', '-File',
            (ConvertTo-IntentArcPreflightExecutionQuotedArgument $envelopePath), ('-' + $Invocation.mode), '-AuthorizationManifest',
            (ConvertTo-IntentArcPreflightExecutionQuotedArgument $Invocation.manifestPath), '-ExpectedAuthorizationSha256', $Invocation.expectedSha256
        ) -join ' '
        return [string]::Equals($metadata.RawCommandLine, $reviewed, [StringComparison]::Ordinal)
    } catch { return $false }
}

function Test-IntentArcPreflightOnceInvocation {
    param([Parameter(Mandatory)][string[]] $RawArguments, [Parameter(Mandatory)] $InvocationMetadata)
    if ($RawArguments.Count -ne 5) { return $null }
    if ($RawArguments[0] -cne '-Execute' -and $RawArguments[0] -cne '-AuditOnly') { return $null }
    if ($RawArguments[1] -cne '-AuthorizationManifest' -or $RawArguments[2] -cne $script:IntentArcPreflightExecutionManifestPath -or $RawArguments[3] -cne '-ExpectedAuthorizationSha256') { return $null }
    if ($RawArguments[4] -cnotmatch '^[0-9a-f]{64}$') { return $null }
    return [pscustomobject][ordered]@{
        mode = $RawArguments[0].Substring(1)
        manifestPath = $RawArguments[2]
        expectedSha256 = $RawArguments[4]
        InvocationMetadata = $InvocationMetadata
    }
}

function Get-IntentArcPreflightExecutionPinnedFaults {
    param([Parameter(Mandatory)] $Contract, [Parameter(Mandatory)][string] $Purpose)
    $initialFault = $null
    $postFault = $null
    $disposeFault = $false
    if (Test-IntentArcPreflightEnvelopeInternalContract $Contract) {
        $hooks = $Contract.TestHooks
        if ($Purpose -ceq 'manifest') {
            $hooks.ManifestOpenCount = [int]($hooks.ManifestOpenCount + 1)
            $initialFault = $hooks.ManifestInitialObservationFault
            $postFault = $hooks.ManifestPostReadObservationFault
        } else {
            $hooks.BoundOpenCount = [int]($hooks.BoundOpenCount + 1)
            if ($hooks.BoundInitialFaultName -is [string] -and [string]::Equals($hooks.BoundInitialFaultName, $Purpose, [StringComparison]::Ordinal)) {
                $initialFault = $hooks.BoundInitialObservationFault
            }
            if ($hooks.BoundPostReadFaultName -is [string] -and [string]::Equals($hooks.BoundPostReadFaultName, $Purpose, [StringComparison]::Ordinal)) {
                $postFault = $hooks.BoundPostReadObservationFault
            }
        }
        if ($hooks.DisposeFaultName -is [string] -and [string]::Equals($hooks.DisposeFaultName, $Purpose, [StringComparison]::Ordinal)) { $disposeFault = $true }
        if ($null -ne $initialFault -or $null -ne $postFault -or $disposeFault) { $hooks.FaultApplications = [int]($hooks.FaultApplications + 1) }
    }
    return [pscustomobject]@{ Initial = $initialFault; Post = $postFault; Dispose = $disposeFault }
}

function Open-IntentArcPreflightExecutionPinnedManifestFile {
    param(
        [Parameter(Mandatory)][string] $LiteralPath,
        [Parameter(Mandatory)][string] $ExpectedFinalPath,
        [Parameter(Mandatory)] $Contract,
        [Parameter(Mandatory)][string] $Purpose
    )
    if (-not (Test-IntentArcPreflightEnvelopeContract $Contract)) { Throw-IntentArcPreflightExecutionAuthorizationInvalid }
    Initialize-IntentArcPreflightExecutionNative
    $faults = Get-IntentArcPreflightExecutionPinnedFaults -Contract $Contract -Purpose $Purpose
    try { return [IntentArc.PreflightEnvelope.PinnedManifestFile]::new($LiteralPath, $ExpectedFinalPath, $faults.Initial, $faults.Post, [bool]$faults.Dispose) }
    catch { Throw-IntentArcPreflightExecutionAuthorizationInvalid }
}

function Assert-IntentArcPreflightExecutionJsonHasNoDuplicateKeys {
    param([Parameter(Mandatory)][string] $Text)
    $state = [pscustomobject]@{ Position = 0; Length = $Text.Length }
    function Skip-IntentArcPreflightExecutionJsonWhitespace {
        while ($state.Position -lt $state.Length) {
            $character = $Text[$state.Position]
            if ($character -ceq ' ' -or $character -ceq "`t" -or $character -ceq "`r" -or $character -ceq "`n") { $state.Position++ }
            else { break }
        }
    }
    function Read-IntentArcPreflightExecutionJsonString {
        if ($state.Position -ge $state.Length -or $Text[$state.Position] -cne '"') { Throw-IntentArcPreflightExecutionAuthorizationInvalid }
        $state.Position++
        $builder = [Text.StringBuilder]::new()
        while ($state.Position -lt $state.Length) {
            $character = $Text[$state.Position++]
            if ($character -ceq '"') { return $builder.ToString() }
            if ([int][char]$character -lt 32) { Throw-IntentArcPreflightExecutionAuthorizationInvalid }
            if ($character -cne '\') { [void] $builder.Append($character); continue }
            if ($state.Position -ge $state.Length) { Throw-IntentArcPreflightExecutionAuthorizationInvalid }
            $escape = [string] $Text[$state.Position++]
            switch -CaseSensitive ($escape) {
                '"' { [void] $builder.Append('"'); break }
                '\' { [void] $builder.Append('\'); break }
                '/' { [void] $builder.Append('/'); break }
                'b' { [void] $builder.Append([char]8); break }
                'f' { [void] $builder.Append([char]12); break }
                'n' { [void] $builder.Append([char]10); break }
                'r' { [void] $builder.Append([char]13); break }
                't' { [void] $builder.Append([char]9); break }
                'u' {
                    if ($state.Position + 4 -gt $state.Length) { Throw-IntentArcPreflightExecutionAuthorizationInvalid }
                    $hex = $Text.Substring($state.Position, 4)
                    if ($hex -cnotmatch '^[0-9a-fA-F]{4}$') { Throw-IntentArcPreflightExecutionAuthorizationInvalid }
                    [void] $builder.Append([char][Convert]::ToInt32($hex, 16)); $state.Position += 4; break
                }
                default { Throw-IntentArcPreflightExecutionAuthorizationInvalid }
            }
        }
        Throw-IntentArcPreflightExecutionAuthorizationInvalid
    }
    function Read-IntentArcPreflightExecutionJsonValue {
        Skip-IntentArcPreflightExecutionJsonWhitespace
        if ($state.Position -ge $state.Length) { Throw-IntentArcPreflightExecutionAuthorizationInvalid }
        $character = $Text[$state.Position]
        if ($character -ceq '{') {
            $state.Position++; Skip-IntentArcPreflightExecutionJsonWhitespace
            $keys = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
            if ($state.Position -lt $state.Length -and $Text[$state.Position] -ceq '}') { $state.Position++; return }
            while ($true) {
                Skip-IntentArcPreflightExecutionJsonWhitespace; $key = Read-IntentArcPreflightExecutionJsonString
                if (-not $keys.Add($key)) { Throw-IntentArcPreflightExecutionAuthorizationInvalid }
                Skip-IntentArcPreflightExecutionJsonWhitespace
                if ($state.Position -ge $state.Length -or $Text[$state.Position] -cne ':') { Throw-IntentArcPreflightExecutionAuthorizationInvalid }
                $state.Position++; Read-IntentArcPreflightExecutionJsonValue; Skip-IntentArcPreflightExecutionJsonWhitespace
                if ($state.Position -ge $state.Length) { Throw-IntentArcPreflightExecutionAuthorizationInvalid }
                if ($Text[$state.Position] -ceq '}') { $state.Position++; return }
                if ($Text[$state.Position] -cne ',') { Throw-IntentArcPreflightExecutionAuthorizationInvalid }
                $state.Position++
            }
        }
        if ($character -ceq '[') {
            $state.Position++; Skip-IntentArcPreflightExecutionJsonWhitespace
            if ($state.Position -lt $state.Length -and $Text[$state.Position] -ceq ']') { $state.Position++; return }
            while ($true) {
                Read-IntentArcPreflightExecutionJsonValue; Skip-IntentArcPreflightExecutionJsonWhitespace
                if ($state.Position -ge $state.Length) { Throw-IntentArcPreflightExecutionAuthorizationInvalid }
                if ($Text[$state.Position] -ceq ']') { $state.Position++; return }
                if ($Text[$state.Position] -cne ',') { Throw-IntentArcPreflightExecutionAuthorizationInvalid }
                $state.Position++
            }
        }
        if ($character -ceq '"') { [void] (Read-IntentArcPreflightExecutionJsonString); return }
        foreach ($literal in @('true', 'false', 'null')) {
            if ($state.Position + $literal.Length -le $state.Length -and $Text.Substring($state.Position, $literal.Length) -ceq $literal) { $state.Position += $literal.Length; return }
        }
        $number = [Regex]::Match($Text.Substring($state.Position), '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?')
        if (-not $number.Success) { Throw-IntentArcPreflightExecutionAuthorizationInvalid }
        $state.Position += $number.Length
    }
    Read-IntentArcPreflightExecutionJsonValue
    if ($state.Position -ne $state.Length) { Throw-IntentArcPreflightExecutionAuthorizationInvalid }
}

function Get-IntentArcPreflightExecutionDocumentValue {
    param([Parameter(Mandatory)] $Document, [Parameter(Mandatory)][string] $Name)
    foreach ($property in $Document.PSObject.Properties) {
        if ([string]::Equals($property.Name, $Name, [StringComparison]::Ordinal)) {
            Write-Output -NoEnumerate $property.Value
            return
        }
    }
    Throw-IntentArcPreflightExecutionAuthorizationInvalid
}

function Assert-IntentArcPreflightExecutionExactKeys {
    param([Parameter(Mandatory)] $Document)
    if (-not (Test-IntentArcPreflightExecutionExactPropertyNames -Value $Document -Expected $script:IntentArcPreflightExecutionAuthorizationKeys)) {
        Throw-IntentArcPreflightExecutionAuthorizationInvalid
    }
}

function Assert-IntentArcPreflightExecutionManifestTypes {
    param([Parameter(Mandatory)] $Document)
    $integerKeys = [Collections.Generic.HashSet[string]]::new([string[]]@('maximumControllerStdoutBytes', 'maximumControllerStderrBytes', 'maximumAttempts'), [StringComparer]::Ordinal)
    $booleanKeys = [Collections.Generic.HashSet[string]]::new([string[]]@('retryAuthorized', 'restoreOnlyAuthorized', 'signedReleaseAuthorized'), [StringComparer]::Ordinal)
    foreach ($name in $script:IntentArcPreflightExecutionAuthorizationKeys) {
        $value = Get-IntentArcPreflightExecutionDocumentValue -Document $Document -Name $name
        if ($integerKeys.Contains($name)) { if ($value -isnot [int]) { Throw-IntentArcPreflightExecutionAuthorizationInvalid } }
        elseif ($booleanKeys.Contains($name)) { if ($value -isnot [bool]) { Throw-IntentArcPreflightExecutionAuthorizationInvalid } }
        elseif ($value -isnot [string]) { Throw-IntentArcPreflightExecutionAuthorizationInvalid }
    }
}

function Test-IntentArcPreflightExecutionCanonicalTimestamp {
    param([Parameter(Mandatory)] $Value)
    if ($Value -isnot [string] -or $Value -cnotmatch '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$') { return $false }
    $parsed = [DateTimeOffset]::MinValue
    $styles = [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal
    if (-not [DateTimeOffset]::TryParseExact($Value, 'yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture, $styles, [ref]$parsed)) { return $false }
    return [string]::Equals($parsed.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fff'Z'", [Globalization.CultureInfo]::InvariantCulture), $Value, [StringComparison]::Ordinal)
}

function Get-IntentArcPreflightExecutionPinnedFileSha256 {
    param(
        [Parameter(Mandatory)][string] $LiteralPath,
        [Parameter(Mandatory)][string] $ExpectedFinalPath,
        [Parameter(Mandatory)] $Contract,
        [Parameter(Mandatory)][string] $Purpose,
        [Parameter(Mandatory)][IntentArc.PreflightEnvelope.PinnedManifestFile] $OwnerGuard
    )
    $guard = $null
    $disposeFailed = $false
    try {
        $guard = Open-IntentArcPreflightExecutionPinnedManifestFile -LiteralPath $LiteralPath -ExpectedFinalPath $ExpectedFinalPath -Contract $Contract -Purpose $Purpose
        $bytes = $guard.ReadBoundedAndRevalidate(268435456)
        $digest = Get-IntentArcPreflightExecutionSha256 -Bytes $bytes
        $OwnerGuard.Retain($guard)
        $guard = $null
        return $digest
    } catch { Throw-IntentArcPreflightExecutionAuthorizationInvalid }
    finally {
        if ($null -ne $guard) {
            try { $guard.Dispose() } catch { $disposeFailed = $true }
        }
        if ($disposeFailed) { Throw-IntentArcPreflightExecutionAuthorizationInvalid }
    }
}

function Read-IntentArcPreflightExecutionAuthorizationManifest {
    param(
        [Parameter(Mandatory)][string] $LiteralPath,
        [Parameter(Mandatory)][string] $ExpectedSha256,
        [Parameter(Mandatory)] $ActualInvocation,
        [Parameter(Mandatory)] $Contract
    )
    $guard = $null
    try {
        if ($ExpectedSha256 -cnotmatch '^[0-9a-f]{64}$' -or -not (Test-IntentArcPreflightEnvelopeContract $Contract) -or
            -not (Test-IntentArcPreflightExecutionFullyQualifiedWindowsPath $LiteralPath)) { Throw-IntentArcPreflightExecutionAuthorizationInvalid }
        if ($Contract.Internal -eq $false -and -not [string]::Equals($LiteralPath, $script:IntentArcPreflightExecutionManifestPath, [StringComparison]::Ordinal)) { Throw-IntentArcPreflightExecutionAuthorizationInvalid }
        if ($ActualInvocation.mode -isnot [string] -or ($ActualInvocation.mode -cne 'Execute' -and $ActualInvocation.mode -cne 'AuditOnly') -or
            $ActualInvocation.manifestPath -isnot [string] -or $ActualInvocation.expectedSha256 -isnot [string] -or
            -not [string]::Equals($ActualInvocation.manifestPath, $LiteralPath, [StringComparison]::Ordinal) -or
            -not [string]::Equals($ActualInvocation.expectedSha256, $ExpectedSha256, [StringComparison]::Ordinal) -or
            -not (Test-IntentArcPreflightExecutionOuterHostBinding -Invocation $ActualInvocation -Contract $Contract)) {
            Throw-IntentArcPreflightExecutionAuthorizationInvalid
        }
        $guard = Open-IntentArcPreflightExecutionPinnedManifestFile -LiteralPath $LiteralPath -ExpectedFinalPath $LiteralPath -Contract $Contract -Purpose 'manifest'
        $bytes = $guard.ReadBoundedAndRevalidate(65536)
        $actualSha256 = Get-IntentArcPreflightExecutionSha256 -Bytes $bytes
        if (-not (Test-IntentArcPreflightExecutionFixedTimeText -Left $actualSha256 -Right $ExpectedSha256)) { Throw-IntentArcPreflightExecutionAuthorizationInvalid }
        if ($bytes.Length -ge 3 -and $bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191) { Throw-IntentArcPreflightExecutionAuthorizationInvalid }
        $json = [Text.UTF8Encoding]::new($false, $true).GetString($bytes)
        Assert-IntentArcPreflightExecutionJsonHasNoDuplicateKeys -Text $json
        $document = $json | ConvertFrom-Json -ErrorAction Stop
        Assert-IntentArcPreflightExecutionExactKeys -Document $document
        Assert-IntentArcPreflightExecutionManifestTypes -Document $document

        $expected = [ordered]@{
            schema = 'intentarc.preflight-execution-authorization/v1'
            attemptId = $script:IntentArcPreflightExecutionAttemptId
            controllerRunId = $script:IntentArcPreflightExecutionControllerRunId
            jobName = 'IntentArc.Preflight.phase1-preflight-20260901-06'
            canonicalPath = $Contract.Root
            branch = 'master'
            authorizationManifestPath = $LiteralPath
            envelopePath = Get-IntentArcPreflightExecutionExpectedBinding -Contract $Contract -Name 'envelope'
            controllerPath = Get-IntentArcPreflightExecutionExpectedBinding -Contract $Contract -Name 'controller'
            gitPath = Get-IntentArcPreflightExecutionExpectedBinding -Contract $Contract -Name 'git'
            nodePath = Get-IntentArcPreflightExecutionExpectedBinding -Contract $Contract -Name 'node'
            cmdPath = Get-IntentArcPreflightExecutionExpectedBinding -Contract $Contract -Name 'cmd'
            pnpmPath = Get-IntentArcPreflightExecutionExpectedBinding -Contract $Contract -Name 'pnpm'
            outerPowerShellPath = Get-IntentArcPreflightExecutionExpectedBinding -Contract $Contract -Name 'host'
        }
        foreach ($name in $expected.Keys) {
            $value = Get-IntentArcPreflightExecutionDocumentValue -Document $document -Name $name
            if (-not (Test-IntentArcPreflightExecutionFixedText -Actual $value -Expected $expected[$name])) { Throw-IntentArcPreflightExecutionAuthorizationInvalid }
        }
        $commit = Get-IntentArcPreflightExecutionDocumentValue -Document $document -Name 'expectedCommit'
        if ($commit -cnotmatch '^[0-9a-f]{40}$') { Throw-IntentArcPreflightExecutionAuthorizationInvalid }

        foreach ($name in @('envelope', 'controller', 'git', 'node', 'cmd', 'pnpm', 'host')) {
            $pathName = if ($name -ceq 'host') { 'outerPowerShellPath' } else { $name + 'Path' }
            $hashName = if ($name -ceq 'host') { 'outerPowerShellSha256' } else { $name + 'Sha256' }
            $path = Get-IntentArcPreflightExecutionDocumentValue -Document $document -Name $pathName
            $digest = Get-IntentArcPreflightExecutionDocumentValue -Document $document -Name $hashName
            if ($digest -cnotmatch '^[0-9a-f]{64}$') { Throw-IntentArcPreflightExecutionAuthorizationInvalid }
            $observedDigest = Get-IntentArcPreflightExecutionPinnedFileSha256 -LiteralPath $path -ExpectedFinalPath $path -Contract $Contract -Purpose $name -OwnerGuard $guard
            if (-not (Test-IntentArcPreflightExecutionFixedTimeText -Left $observedDigest -Right $digest)) { Throw-IntentArcPreflightExecutionAuthorizationInvalid }
        }
        foreach ($name in @('maximumControllerStdoutBytes', 'maximumControllerStderrBytes')) {
            if ((Get-IntentArcPreflightExecutionDocumentValue -Document $document -Name $name) -ne 1048576) { Throw-IntentArcPreflightExecutionAuthorizationInvalid }
        }
        if ((Get-IntentArcPreflightExecutionDocumentValue -Document $document -Name 'maximumAttempts') -ne 1) { Throw-IntentArcPreflightExecutionAuthorizationInvalid }
        foreach ($name in @('retryAuthorized', 'restoreOnlyAuthorized', 'signedReleaseAuthorized')) {
            if (Get-IntentArcPreflightExecutionDocumentValue -Document $document -Name $name) { Throw-IntentArcPreflightExecutionAuthorizationInvalid }
        }
        if (-not (Test-IntentArcPreflightExecutionCanonicalTimestamp (Get-IntentArcPreflightExecutionDocumentValue -Document $document -Name 'createdAtUtc'))) {
            Throw-IntentArcPreflightExecutionAuthorizationInvalid
        }
        return [IntentArc.PreflightEnvelope.ValidatedAuthorizationContext]::new($document, $guard, $bytes, $actualSha256, $ActualInvocation, $Contract)
    } catch {
        if ($null -ne $guard) { try { $guard.Dispose() } catch {} }
        Throw-IntentArcPreflightExecutionAuthorizationInvalid
    }
}

function Get-IntentArcPreflightEnvelopeOperationNames {
    param()
    if ($args.Count -ne 0) { throw 'operation-map-invalid' }
    return [string[]] @($script:IntentArcPreflightEnvelopeOperationNames)
}

function Test-IntentArcPreflightEnvelopeOrderedPropertyNames {
    param([Parameter(Mandatory)] $Value, [Parameter(Mandatory)][string[]] $Expected)
    if ($null -eq $Value) { return $false }
    $actual = @($Value.PSObject.Properties | ForEach-Object { $_.Name })
    if ($actual.Count -ne $Expected.Count) { return $false }
    for ($index = 0; $index -lt $Expected.Count; $index++) {
        if (-not [string]::Equals([string]$actual[$index], $Expected[$index], [StringComparison]::Ordinal)) { return $false }
    }
    return $true
}

function New-IntentArcPreflightEnvelopeOperationDescriptor {
    param(
        [Parameter(Mandatory)][string] $Name,
        [Parameter(Mandatory)][string] $Category,
        [Parameter(Mandatory)][scriptblock] $Handler,
        [Parameter(Mandatory)][AllowEmptyCollection()][Collections.Generic.List[IDisposable]] $EvidenceGuards,
        [scriptblock] $Observer,
        [string] $FaultAfterOperation
    )
    $capturedName = $Name
    $capturedHandler = $Handler
    $capturedObserver = $Observer
    $capturedFault = $FaultAfterOperation
    $capturedEvidenceGuards = $EvidenceGuards
    $capturedRetentionState = $script:IntentArcPreflightEnvelopeEvidenceRetentionState
    $invoke = {
        param($Argument0, $Argument1, $Argument2, $Argument3)
        if ($null -ne $capturedObserver) { [void] (& $capturedObserver $capturedName) }
        $previousRetention = $capturedRetentionState.Value
        try {
            if ($capturedName -ceq 'WriteConsumptionAttempted' -or $capturedName -ceq 'WriteControllerStarted') {
                $capturedRetentionState.Value = $capturedEvidenceGuards
            }
            $result = & $capturedHandler $Argument0 $Argument1 $Argument2 $Argument3
        } finally {
            $capturedRetentionState.Value = $previousRetention
        }
        if ($capturedFault -is [string] -and [string]::Equals($capturedFault, $capturedName, [StringComparison]::Ordinal)) {
            throw 'fixture-host-loss'
        }
        Write-Output -NoEnumerate $result
    }.GetNewClosure()
    $invoke | Add-Member -MemberType NoteProperty -Name category -Value $Category -Force
    return $invoke
}

function New-IntentArcPreflightEnvelopeOperations {
    param(
        [Parameter(Mandatory)][Collections.IDictionary] $Handlers,
        [scriptblock] $Observer,
        [string] $FaultAfterOperation
    )
    if (-not $script:IntentArcPreflightEnvelopeWasDotSourced -or $args.Count -ne 0 -or
        $Handlers.Count -ne $script:IntentArcPreflightEnvelopeOperationNames.Count) { throw 'operation-map-invalid' }
    return New-IntentArcPreflightEnvelopeOperationMap -Handlers $Handlers -Observer $Observer -FaultAfterOperation $FaultAfterOperation
}

function New-IntentArcPreflightEnvelopeOperationMap {
    param([Parameter(Mandatory)][Collections.IDictionary] $Handlers, [scriptblock] $Observer, [string] $FaultAfterOperation)
    if ($args.Count -ne 0 -or $Handlers.Count -ne $script:IntentArcPreflightEnvelopeOperationNames.Count) { throw 'operation-map-invalid' }
    if (-not [string]::IsNullOrEmpty($FaultAfterOperation) -and
        -not ($script:IntentArcPreflightEnvelopeOperationNames -ccontains $FaultAfterOperation)) { throw 'operation-map-invalid' }
    $operations = [ordered]@{}
    $evidenceGuards = [Collections.Generic.List[IDisposable]]::new()
    foreach ($name in $script:IntentArcPreflightEnvelopeOperationNames) {
        if (-not $Handlers.Contains($name) -or $Handlers[$name] -isnot [scriptblock]) { throw 'operation-map-invalid' }
        $operations[$name] = New-IntentArcPreflightEnvelopeOperationDescriptor -Name $name -Category $script:IntentArcPreflightEnvelopeOperationCategories[$name] -Handler $Handlers[$name] -EvidenceGuards $evidenceGuards -Observer $Observer -FaultAfterOperation $FaultAfterOperation
    }
    foreach ($candidate in @($Handlers.Keys)) {
        if ($candidate -isnot [string] -or -not ($script:IntentArcPreflightEnvelopeOperationNames -ccontains $candidate)) { throw 'operation-map-invalid' }
    }
    $operationMap = [pscustomobject] $operations
    $disposeEvidenceGuards = {
        $firstError = $null
        for ($index = $evidenceGuards.Count - 1; $index -ge 0; $index--) {
            try { $evidenceGuards[$index].Dispose() } catch { if ($null -eq $firstError) { $firstError = $_ } }
        }
        $evidenceGuards.Clear()
        if ($null -ne $firstError) { throw $firstError }
    }.GetNewClosure()
    $operationMap | Add-Member -MemberType ScriptMethod -Name DisposeEvidenceGuards -Value $disposeEvidenceGuards
    return $operationMap
}

function Assert-IntentArcPreflightEnvelopeOperations {
    param([Parameter(Mandatory)] $Operations)
    if (-not (Test-IntentArcPreflightEnvelopeOrderedPropertyNames -Value $Operations -Expected $script:IntentArcPreflightEnvelopeOperationNames)) {
        throw 'operation-map-invalid'
    }
    if ($null -eq $Operations.PSObject.Methods['DisposeEvidenceGuards']) { throw 'operation-map-invalid' }
    foreach ($name in $script:IntentArcPreflightEnvelopeOperationNames) {
        $descriptor = $Operations.$name
        if ($descriptor -isnot [scriptblock] -or $descriptor.category -isnot [string] -or
            -not [string]::Equals($descriptor.category, $script:IntentArcPreflightEnvelopeOperationCategories[$name], [StringComparison]::Ordinal) -or
            $null -eq $descriptor.PSObject.Methods['Invoke']) { throw 'operation-map-invalid' }
    }
}

function Assert-IntentArcPreflightEnvelopeAuthorizationContext {
    param([Parameter(Mandatory)] $AuthorizationContext)
    if ($AuthorizationContext.GetType() -ne [IntentArc.PreflightEnvelope.ValidatedAuthorizationContext] -or
        -not (Test-IntentArcPreflightEnvelopeOrderedPropertyNames -Value $AuthorizationContext -Expected @('Document', 'ManifestGuard', 'ExactBytes', 'Sha256', 'Invocation', 'Contract')) -or
        $AuthorizationContext.ManifestGuard -isnot [IntentArc.PreflightEnvelope.PinnedManifestFile] -or
        $AuthorizationContext.ExactBytes -isnot [byte[]] -or $AuthorizationContext.ExactBytes.Length -lt 1 -or
        $AuthorizationContext.Sha256 -isnot [string] -or $AuthorizationContext.Sha256 -cnotmatch '^[0-9a-f]{64}$' -or
        -not (Test-IntentArcPreflightEnvelopeContract $AuthorizationContext.Contract) -or
        -not (Test-IntentArcPreflightExecutionFixedText -Actual $AuthorizationContext.Document.attemptId -Expected $script:IntentArcPreflightExecutionAttemptId) -or
        -not (Test-IntentArcPreflightExecutionFixedText -Actual $AuthorizationContext.Document.controllerRunId -Expected $script:IntentArcPreflightExecutionControllerRunId)) {
        throw 'authorization-context-invalid'
    }
}

function Test-IntentArcPreflightEnvelopeFixedBytes {
    param([Parameter(Mandatory)][byte[]] $Left, [Parameter(Mandatory)][byte[]] $Right)
    if ($Left.Length -ne $Right.Length) { return $false }
    $difference = 0
    for ($index = 0; $index -lt $Left.Length; $index++) { $difference = $difference -bor ($Left[$index] -bxor $Right[$index]) }
    return $difference -eq 0
}

function Read-IntentArcPreflightEnvelopeRetainedManifestBytes {
    param([Parameter(Mandatory)] $AuthorizationContext)
    Assert-IntentArcPreflightEnvelopeAuthorizationContext -AuthorizationContext $AuthorizationContext
    $AuthorizationContext.ManifestGuard.Stream.Position = 0
    $bytes = $AuthorizationContext.ManifestGuard.ReadBoundedAndRevalidate(65536)
    if (-not (Test-IntentArcPreflightEnvelopeFixedBytes -Left $bytes -Right $AuthorizationContext.ExactBytes) -or
        -not (Test-IntentArcPreflightExecutionFixedTimeText -Left (Get-IntentArcPreflightExecutionSha256 -Bytes $bytes) -Right $AuthorizationContext.Sha256)) {
        throw 'authorization-context-invalid'
    }
    return ,$bytes
}

function New-IntentArcPreflightEnvelopeAttemptRoot {
    param([Parameter(Mandatory)] $AuthorizationContext)
    Assert-IntentArcPreflightEnvelopeAuthorizationContext -AuthorizationContext $AuthorizationContext
    Initialize-IntentArcPreflightExecutionNative
    $parent = Join-Path $AuthorizationContext.Contract.Root '.superpowers\preflight-execution-envelope'
    return [IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::CreateExclusiveRoot($parent, $script:IntentArcPreflightExecutionAttemptId)
}

function Write-IntentArcPreflightEnvelopeImmutableBytes {
    param(
        [Parameter(Mandatory)][IntentArc.PreflightEnvelope.BoundaryGuard] $RootGuard,
        [Parameter(Mandatory)][string] $Leaf,
        [Parameter(Mandatory)][byte[]] $Bytes,
        [Parameter(Mandatory)][int] $MaximumBytes
    )
    if ($Bytes.Length -lt 1 -or $Bytes.Length -gt $MaximumBytes) { throw 'evidence-write-invalid' }
    $guard = $null
    $retention = $script:IntentArcPreflightEnvelopeEvidenceRetentionState.Value
    try {
        if ($retention -is [Collections.Generic.List[IDisposable]]) {
            $capturedRetention = $retention
            $retainAfterPromotion = [Action[IntentArc.PreflightEnvelope.BoundaryGuard]] {
                param($candidate)
                [void] $capturedRetention.Add($candidate)
            }.GetNewClosure()
            $guard = [IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::WriteAtomicNew($RootGuard, $Leaf, $Bytes, $retainAfterPromotion)
        } else {
            $guard = [IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::WriteAtomicNew($RootGuard, $Leaf, $Bytes)
        }
        $reopened = $guard.ReadAllBytes($MaximumBytes)
        if (-not [IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::ValidateProtection($guard) -or
            -not (Test-IntentArcPreflightEnvelopeFixedBytes -Left $reopened -Right $Bytes)) { throw 'evidence-write-invalid' }
        return [pscustomobject][ordered]@{ sha256 = Get-IntentArcPreflightExecutionSha256 -Bytes $reopened }
    } finally {
        if ($null -ne $guard -and ($retention -isnot [Collections.Generic.List[IDisposable]] -or -not $retention.Contains($guard))) {
            $guard.Dispose()
        }
    }
}

function Copy-IntentArcPreflightEnvelopeAuthorization {
    param(
        [Parameter(Mandatory)] $AuthorizationContext,
        [Parameter(Mandatory)][IntentArc.PreflightEnvelope.BoundaryGuard] $RootGuard
    )
    $bytes = Read-IntentArcPreflightEnvelopeRetainedManifestBytes -AuthorizationContext $AuthorizationContext
    $result = Write-IntentArcPreflightEnvelopeImmutableBytes -RootGuard $RootGuard -Leaf 'authorization.json' -Bytes $bytes -MaximumBytes 65536
    if (-not (Test-IntentArcPreflightExecutionFixedTimeText -Left $result.sha256 -Right $AuthorizationContext.Sha256)) { throw 'evidence-write-invalid' }
    return $result
}

function ConvertTo-IntentArcPreflightEnvelopeCanonicalBytes {
    param([Parameter(Mandatory)] $Document)
    $text = $Document | ConvertTo-Json -Compress -Depth 8 -ErrorAction Stop
    return ,[Text.UTF8Encoding]::new($false, $true).GetBytes($text)
}

function Write-IntentArcPreflightEnvelopeConsumptionAttempted {
    param(
        [Parameter(Mandatory)] $AuthorizationContext,
        [Parameter(Mandatory)][IntentArc.PreflightEnvelope.BoundaryGuard] $RootGuard
    )
    Assert-IntentArcPreflightEnvelopeAuthorizationContext -AuthorizationContext $AuthorizationContext
    $document = [ordered]@{
        schema = 'intentarc.preflight-execution-consumed/v1'
        attemptId = $script:IntentArcPreflightExecutionAttemptId
        authorizationSha256 = $AuthorizationContext.Sha256
        consumedAtUtc = [DateTimeOffset]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fff'Z'", [Globalization.CultureInfo]::InvariantCulture)
        controllerLaunchStatus = 'attempted'
    }
    $bytes = ConvertTo-IntentArcPreflightEnvelopeCanonicalBytes -Document $document
    $parsed = ([Text.UTF8Encoding]::new($false, $true).GetString($bytes) | ConvertFrom-Json -ErrorAction Stop)
    if (-not (Test-IntentArcPreflightEnvelopeOrderedPropertyNames -Value $parsed -Expected @('schema', 'attemptId', 'authorizationSha256', 'consumedAtUtc', 'controllerLaunchStatus')) -or
        -not (Test-IntentArcPreflightExecutionFixedText -Actual $parsed.schema -Expected 'intentarc.preflight-execution-consumed/v1') -or
        -not (Test-IntentArcPreflightExecutionFixedText -Actual $parsed.attemptId -Expected $script:IntentArcPreflightExecutionAttemptId) -or
        -not (Test-IntentArcPreflightExecutionFixedText -Actual $parsed.authorizationSha256 -Expected $AuthorizationContext.Sha256) -or
        -not (Test-IntentArcPreflightExecutionCanonicalTimestamp $parsed.consumedAtUtc) -or
        -not (Test-IntentArcPreflightExecutionFixedText -Actual $parsed.controllerLaunchStatus -Expected 'attempted')) { throw 'consumption-invalid' }
    return Write-IntentArcPreflightEnvelopeImmutableBytes -RootGuard $RootGuard -Leaf 'consumed.json' -Bytes $bytes -MaximumBytes 16384
}

function Write-IntentArcPreflightEnvelopeControllerStarted {
    param(
        [Parameter(Mandatory)] $AuthorizationContext,
        [Parameter(Mandatory)][IntentArc.PreflightEnvelope.BoundaryGuard] $RootGuard,
        [Parameter(Mandatory)][string] $ConsumedSha256,
        [Parameter(Mandatory)] $ProcessId,
        [Parameter(Mandatory)] $StartTimeUtc
    )
    Assert-IntentArcPreflightEnvelopeAuthorizationContext -AuthorizationContext $AuthorizationContext
    if ($ConsumedSha256 -cnotmatch '^[0-9a-f]{64}$' -or $ProcessId -isnot [int] -or $ProcessId -le 0 -or
        $StartTimeUtc -isnot [string] -or -not (Test-IntentArcPreflightExecutionCanonicalTimestamp $StartTimeUtc)) { throw 'controller-started-invalid' }
    $recordedAtUtc = [DateTimeOffset]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fff'Z'", [Globalization.CultureInfo]::InvariantCulture)
    if ([string]::CompareOrdinal($StartTimeUtc, $recordedAtUtc) -gt 0) { throw 'controller-started-invalid' }
    $document = [ordered]@{
        schema = 'intentarc.preflight-execution-controller-started/v1'
        attemptId = $script:IntentArcPreflightExecutionAttemptId
        controllerRunId = $script:IntentArcPreflightExecutionControllerRunId
        authorizationSha256 = $AuthorizationContext.Sha256
        consumedSha256 = $ConsumedSha256
        controllerProcessId = $ProcessId
        controllerStartTimeUtc = $StartTimeUtc
        recordedAtUtc = $recordedAtUtc
    }
    $bytes = ConvertTo-IntentArcPreflightEnvelopeCanonicalBytes -Document $document
    $parsed = ([Text.UTF8Encoding]::new($false, $true).GetString($bytes) | ConvertFrom-Json -ErrorAction Stop)
    if (-not (Test-IntentArcPreflightEnvelopeOrderedPropertyNames -Value $parsed -Expected @('schema', 'attemptId', 'controllerRunId', 'authorizationSha256', 'consumedSha256', 'controllerProcessId', 'controllerStartTimeUtc', 'recordedAtUtc')) -or
        $parsed.controllerProcessId -isnot [int] -or $parsed.controllerProcessId -le 0 -or
        -not (Test-IntentArcPreflightExecutionCanonicalTimestamp $parsed.controllerStartTimeUtc) -or
        -not (Test-IntentArcPreflightExecutionCanonicalTimestamp $parsed.recordedAtUtc)) { throw 'controller-started-invalid' }
    return Write-IntentArcPreflightEnvelopeImmutableBytes -RootGuard $RootGuard -Leaf 'controller-started.json' -Bytes $bytes -MaximumBytes 16384
}

function Get-IntentArcPreflightEnvelopeSingleOperationResult {
    param([Parameter(Mandatory)] $Results)
    $items = @($Results)
    if ($items.Count -ne 1) { throw 'operation-result-invalid' }
    return $items[0]
}

function Assert-IntentArcPreflightEnvelopeBooleanRecord {
    param([Parameter(Mandatory)] $Record, [Parameter(Mandatory)][string] $Name)
    if (-not (Test-IntentArcPreflightEnvelopeOrderedPropertyNames -Value $Record -Expected @($Name)) -or
        $Record.$Name -isnot [bool] -or $Record.$Name -ne $true) { throw 'operation-result-invalid' }
}

function Assert-IntentArcPreflightEnvelopeShaRecord {
    param([Parameter(Mandatory)] $Record)
    if (-not (Test-IntentArcPreflightEnvelopeOrderedPropertyNames -Value $Record -Expected @('sha256')) -or
        $Record.sha256 -isnot [string] -or $Record.sha256 -cnotmatch '^[0-9a-f]{64}$') { throw 'operation-result-invalid' }
}

function Assert-IntentArcPreflightEnvelopeLaunchRecord {
    param([Parameter(Mandatory)] $Record)
    $keys = @('processCreated', 'nonCreationProven', 'supervisor', 'supervisorIdentityValid', 'drainsInitialized', 'setupCategory')
    if (-not (Test-IntentArcPreflightEnvelopeOrderedPropertyNames -Value $Record -Expected $keys) -or
        $Record.processCreated -isnot [bool] -or $Record.nonCreationProven -isnot [bool] -or
        $Record.supervisorIdentityValid -isnot [bool] -or $Record.drainsInitialized -isnot [bool] -or
        $Record.setupCategory -isnot [string]) { throw 'operation-result-invalid' }
    if ($Record.processCreated -eq $false) {
        if ($Record.nonCreationProven -ne $true -or $null -ne $Record.supervisor -or
            $Record.supervisorIdentityValid -ne $false -or $Record.drainsInitialized -ne $false -or
            $Record.setupCategory -cne 'launch-failed') { throw 'operation-result-invalid' }
        return
    }
    if ($Record.nonCreationProven -ne $false -or $null -eq $Record.supervisor -or
        -not (Test-IntentArcPreflightEnvelopeOrderedPropertyNames -Value $Record.supervisor -Expected @('processId', 'startTimeUtc')) -or
        $Record.supervisor.processId -isnot [int] -or $Record.supervisor.processId -le 0 -or
        $Record.supervisor.startTimeUtc -isnot [string] -or -not (Test-IntentArcPreflightExecutionCanonicalTimestamp $Record.supervisor.startTimeUtc)) {
        throw 'operation-result-invalid'
    }
    $expectedCategory = if ($Record.supervisorIdentityValid -eq $false) { 'supervisor-identity-invalid' }
        elseif ($Record.drainsInitialized -eq $false) { 'drain-initialization-invalid' }
        else { 'none' }
    if ($Record.setupCategory -cne $expectedCategory) { throw 'operation-result-invalid' }
}

function Invoke-IntentArcPreflightEnvelopeExecute {
    param(
        [Parameter(Mandatory)] $AuthorizationContext,
        [Parameter(Mandatory)] $Operations
    )
    Assert-IntentArcPreflightEnvelopeAuthorizationContext -AuthorizationContext $AuthorizationContext
    Assert-IntentArcPreflightEnvelopeOperations -Operations $Operations
    [void] (Read-IntentArcPreflightEnvelopeRetainedManifestBytes -AuthorizationContext $AuthorizationContext)
    $outGuard = $null
    try {
        $binding = Get-IntentArcPreflightEnvelopeSingleOperationResult ($Operations.BindExecutionInputs.Invoke($AuthorizationContext.Document))
        Assert-IntentArcPreflightEnvelopeBooleanRecord -Record $binding -Name 'valid'
        $repository = Get-IntentArcPreflightEnvelopeSingleOperationResult ($Operations.GetRepositoryState.Invoke($AuthorizationContext.Document))
        Assert-IntentArcPreflightEnvelopeBooleanRecord -Record $repository -Name 'valid'
        $boundaries = Get-IntentArcPreflightEnvelopeSingleOperationResult ($Operations.GuardBoundaries.Invoke($AuthorizationContext.Document))
        $returnedOutGuards = @($boundaries.PSObject.Properties | Where-Object {
            [string]::Equals($_.Name, 'outGuard', [StringComparison]::Ordinal) -and $_.Value -is [IDisposable]
        })
        if ($returnedOutGuards.Count -eq 1) { $outGuard = $returnedOutGuards[0].Value }
        if (-not (Test-IntentArcPreflightEnvelopeOrderedPropertyNames -Value $boundaries -Expected @('valid', 'outGuard')) -or
            $boundaries.valid -isnot [bool] -or $boundaries.valid -ne $true -or $boundaries.outGuard -isnot [IDisposable]) { throw 'operation-result-invalid' }
        $unused = Get-IntentArcPreflightEnvelopeSingleOperationResult ($Operations.ProbeId06Unused.Invoke($AuthorizationContext.Document))
        Assert-IntentArcPreflightEnvelopeBooleanRecord -Record $unused -Name 'unused'
        $root = Get-IntentArcPreflightEnvelopeSingleOperationResult ($Operations.CreateAttemptRoot.Invoke($AuthorizationContext.Document))
        Assert-IntentArcPreflightEnvelopeBooleanRecord -Record $root -Name 'created'
        $copy = Get-IntentArcPreflightEnvelopeSingleOperationResult ($Operations.CopyAuthorization.Invoke($AuthorizationContext.Document))
        Assert-IntentArcPreflightEnvelopeShaRecord -Record $copy
        if (-not (Test-IntentArcPreflightExecutionFixedTimeText -Left $copy.sha256 -Right $AuthorizationContext.Sha256)) { throw 'operation-result-invalid' }
        $consumption = Get-IntentArcPreflightEnvelopeSingleOperationResult ($Operations.WriteConsumptionAttempted.Invoke($AuthorizationContext.Document))
        Assert-IntentArcPreflightEnvelopeShaRecord -Record $consumption
        $outGuard.Dispose()
        $outGuard = $null
        $launch = $null
        $controllerStartedValid = $false
        try {
            $launch = $Operations.StartController.Invoke($AuthorizationContext.Document)
            $launch = Get-IntentArcPreflightEnvelopeSingleOperationResult $launch
            Assert-IntentArcPreflightEnvelopeLaunchRecord -Record $launch
            if ($launch.processCreated -eq $true -and $launch.supervisorIdentityValid -eq $true) {
                $started = Get-IntentArcPreflightEnvelopeSingleOperationResult ($Operations.WriteControllerStarted.Invoke($AuthorizationContext.Document, $consumption.sha256, $launch.supervisor.processId, $launch.supervisor.startTimeUtc))
                Assert-IntentArcPreflightEnvelopeShaRecord -Record $started
                $controllerStartedValid = $true
            }
        } finally {
            $finalization = $Operations.FinalizeControllerAttempt.Invoke($AuthorizationContext.Document, $launch, $controllerStartedValid)
            $finalization = Get-IntentArcPreflightEnvelopeSingleOperationResult $finalization
            Assert-IntentArcPreflightEnvelopeBooleanRecord -Record $finalization -Name 'finalized'
        }
        return [pscustomobject][ordered]@{
            consumptionSha256 = $consumption.sha256
            processCreated = $launch.processCreated
            controllerStartedValid = $controllerStartedValid
        }
    } finally {
        try {
            if ($null -ne $outGuard) { $outGuard.Dispose() }
        } finally {
            $Operations.DisposeEvidenceGuards()
        }
    }
}

function Get-IntentArcPreflightAuditProbeDisposition {
    param([Parameter(Mandatory)] $Disposition)
    switch ([string] $Disposition) {
        'Present' { return 'present' }
        'Absent' { return 'absent' }
        default { return 'indeterminate' }
    }
}

function New-IntentArcPreflightTerminalAuditEvidence {
    return [pscustomobject][ordered]@{
        attemptRootDisposition = 'indeterminate'; authorizationCopyValid = $false
        consumptionDisposition = 'absent'; controllerStartedDisposition = 'absent'; attemptReceiptDisposition = 'absent'
        journalBindingsValid = $false; startedReceiptIdentityValid = $false; supervisorIdentityInvalidShape = $false
        receiptInfrastructureCategory = $null; controllerExitCode = $null; controllerStdoutDisposition = 'absent'
        resultDisposition = 'absent'; resultSha256 = $null; stateDisposition = 'absent'; stateSha256 = $null
        id06ReceiptDisposition = 'absent'; receiptSha256 = $null; jobDisposition = 'indeterminate'
        controllerProcessDisposition = 'not-applicable'; childProcessDisposition = 'not-applicable'; settlementValid = $false
        sourceFinalPathValid = $false; sourceStableIdentityValid = $false; sourceParentIdentityValid = $false
        destinationDisposition = 'indeterminate'; cleanupResidueDispositions = @('indeterminate','indeterminate','indeterminate')
        bindingsDisposition = 'indeterminate'; infrastructureValid = $true; storedAuditDisposition = 'absent'
        storedAuditDocument = $null; storedAuditBytesBase64 = $null
    }
}

function Read-IntentArcPreflightTerminalAuditProtectedDocument {
    param(
        [Parameter(Mandatory)][IntentArc.PreflightEnvelope.BoundaryGuard] $RootGuard,
        [Parameter(Mandatory)][string] $RootPath,
        [Parameter(Mandatory)][string] $Leaf,
        [Parameter(Mandatory)][int] $MaximumBytes,
        [Parameter(Mandatory)][string] $Schema,
        [Parameter(Mandatory)][AllowEmptyCollection()][Collections.Generic.List[IDisposable]] $Guards
    )
    $path = Join-Path $RootPath $Leaf
    $disposition = Get-IntentArcPreflightAuditProbeDisposition ([IntentArc.PreflightEnvelope.EntryProbe]::Probe($path))
    if ($disposition -ceq 'absent') { return [pscustomobject][ordered]@{ disposition = 'absent'; value = $null } }
    if ($disposition -cne 'present') { return [pscustomobject][ordered]@{ disposition = 'invalid'; value = $null } }
    $guard = $null
    try {
        $guard = [IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::OpenValidated($RootGuard, $Leaf, $MaximumBytes)
        if ($Schema -ceq 'controllerCapture') {
            $bytes = [byte[]] $guard.ReadAllBytes($MaximumBytes)
            if ($bytes.Length -gt $MaximumBytes -or
                -not [IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::ValidateProtection($guard) -or -not $guard.Revalidate()) { throw 'capture-invalid' }
            $value = [pscustomobject][ordered]@{ bytes = $bytes; sha256 = Get-IntentArcPreflightExecutionSha256 -Bytes $bytes; guard = $guard }
        } else {
            $value = Read-IntentArcClosedJsonDocument -Guard $guard -MaximumBytes $MaximumBytes -Schema $Schema
        }
        [void] $Guards.Add($guard); $guard = $null
        return [pscustomobject][ordered]@{ disposition = 'valid'; value = $value }
    } catch {
        return [pscustomobject][ordered]@{ disposition = 'invalid'; value = $null }
    } finally { if ($null -ne $guard) { $guard.Dispose() } }
}

function Read-IntentArcPreflightTerminalAuditProductionEvidence {
    param(
        [Parameter(Mandatory)] $AuthorizationContext,
        [Parameter(Mandatory)][AllowEmptyCollection()][Collections.Generic.List[IDisposable]] $Guards,
        [Parameter(Mandatory)] $AuditState
    )
    Assert-IntentArcPreflightEnvelopeAuthorizationContext -AuthorizationContext $AuthorizationContext
    Initialize-IntentArcPreflightExecutionNative
    $document = $AuthorizationContext.Document
    $contract = $AuthorizationContext.Contract
    $evidence = New-IntentArcPreflightTerminalAuditEvidence
    $attemptRoot = $null; $consumption = $null; $started = $null; $attemptReceipt = $null; $stdoutRead = $null
    $result = $null; $state = $null; $id06Receipt = $null
    $rootPath = [IO.Path]::GetFullPath([string] $contract.Root)
    $superpowersPath = Join-Path $rootPath '.superpowers'
    $attemptParentPath = Join-Path $superpowersPath 'preflight-execution-envelope'
    $attemptRootPath = Join-Path $attemptParentPath $script:IntentArcPreflightExecutionAttemptId
    $preservationPath = Join-Path $superpowersPath 'preflight-out-preservation'
    $receiptRootPath = Join-Path $superpowersPath 'preflight\desktop-release'
    $sourcePath = Join-Path $rootPath 'out'
    $runRootPath = Join-Path $preservationPath $script:IntentArcPreflightExecutionControllerRunId
    $destinationPath = Join-Path $runRootPath 'out'
    $profilePath = Join-Path $runRootPath 'profile'
    $localAppDataPath = Join-Path $runRootPath 'localappdata'
    try {
        [void](Read-IntentArcPreflightEnvelopeRetainedManifestBytes -AuthorizationContext $AuthorizationContext)
        $rootDisposition = Get-IntentArcPreflightAuditProbeDisposition ([IntentArc.PreflightEnvelope.EntryProbe]::Probe($attemptRootPath))
        $evidence.attemptRootDisposition = $rootDisposition
        if ($rootDisposition -ceq 'present') {
            $attemptParent = $null
            try {
                $attemptParent = [IntentArc.PreflightEnvelope.BoundaryGuard]::OpenDirectory($attemptParentPath, $attemptParentPath)
                if (-not [IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::ValidateProtection($attemptParent)) { throw 'attempt-parent-invalid' }
                [void] $Guards.Add($attemptParent)
                $attemptRoot = [IntentArc.PreflightEnvelope.BoundaryGuard]::OpenDirectory($attemptRootPath, $attemptRootPath)
                if (-not [IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::ValidateProtection($attemptRoot)) { throw 'attempt-root-invalid' }
                [void] $Guards.Add($attemptRoot); $AuditState.RootGuard = $attemptRoot
            } catch {
                if ($null -ne $attemptRoot -and -not $Guards.Contains($attemptRoot)) { $attemptRoot.Dispose() }
                if ($null -ne $attemptParent -and -not $Guards.Contains($attemptParent)) { $attemptParent.Dispose() }
                $attemptRoot = $null
            }
        }
        if ($null -ne $attemptRoot) {
            $authorizationPath = Join-Path $attemptRootPath 'authorization.json'
            if ((Get-IntentArcPreflightAuditProbeDisposition ([IntentArc.PreflightEnvelope.EntryProbe]::Probe($authorizationPath))) -ceq 'present') {
                $authorizationGuard = $null
                try {
                    $authorizationGuard = [IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::OpenValidated($attemptRoot, 'authorization.json', 65536)
                    $authorizationBytes = [byte[]] $authorizationGuard.ReadAllBytes(65536)
                    $evidence.authorizationCopyValid = (Test-IntentArcPreflightEnvelopeFixedBytes -Left $authorizationBytes -Right $AuthorizationContext.ExactBytes) -and
                        (Test-IntentArcPreflightExecutionFixedTimeText -Left (Get-IntentArcPreflightExecutionSha256 -Bytes $authorizationBytes) -Right $AuthorizationContext.Sha256)
                    [void] $Guards.Add($authorizationGuard); $authorizationGuard = $null
                } catch { $evidence.authorizationCopyValid = $false }
                finally { if ($null -ne $authorizationGuard) { $authorizationGuard.Dispose() } }
            }
            $consumptionRead = Read-IntentArcPreflightTerminalAuditProtectedDocument -RootGuard $attemptRoot -RootPath $attemptRootPath -Leaf 'consumed.json' -MaximumBytes 16384 -Schema 'consumption' -Guards $Guards
            $evidence.consumptionDisposition = $consumptionRead.disposition
            if ($consumptionRead.disposition -ceq 'valid') {
                $consumption = $consumptionRead.value
                if (-not (Test-IntentArcPreflightConsumption -Document $consumption.document -AuthorizationSha256 $AuthorizationContext.Sha256)) { $evidence.consumptionDisposition = 'invalid'; $consumption = $null }
            }
            $startedRead = Read-IntentArcPreflightTerminalAuditProtectedDocument -RootGuard $attemptRoot -RootPath $attemptRootPath -Leaf 'controller-started.json' -MaximumBytes 16384 -Schema 'controllerStarted' -Guards $Guards
            $evidence.controllerStartedDisposition = $startedRead.disposition
            if ($startedRead.disposition -ceq 'valid') {
                $started = $startedRead.value
                if ($null -eq $consumption -or -not (Test-IntentArcPreflightControllerStarted -Document $started.document -AuthorizationSha256 $AuthorizationContext.Sha256 -ConsumedSha256 $consumption.sha256)) { $evidence.controllerStartedDisposition = 'invalid'; $started = $null }
            }
            $receiptRead = Read-IntentArcPreflightTerminalAuditProtectedDocument -RootGuard $attemptRoot -RootPath $attemptRootPath -Leaf 'attempt-receipt.json' -MaximumBytes 32768 -Schema 'attemptReceipt' -Guards $Guards
            $evidence.attemptReceiptDisposition = $receiptRead.disposition
            if ($receiptRead.disposition -ceq 'valid') { $attemptReceipt = $receiptRead.value }
            $stdoutRead = Read-IntentArcPreflightTerminalAuditProtectedDocument -RootGuard $attemptRoot -RootPath $attemptRootPath -Leaf 'controller-stdout.json' -MaximumBytes 1048576 -Schema 'controllerCapture' -Guards $Guards
            $evidence.controllerStdoutDisposition = $stdoutRead.disposition
            if ($stdoutRead.disposition -ceq 'valid') {
                try {
                    $parsedResult = Read-IntentArcClosedJsonDocument -Guard $stdoutRead.value.guard -MaximumBytes 65536 -Schema 'id06Result'
                    if (-not (Test-IntentArcPreflightEnvelopeFixedBytes -Left ([byte[]] $stdoutRead.value.bytes) -Right ([byte[]] $parsedResult.bytes)) -or
                        -not (Test-IntentArcPreflightExecutionFixedTimeText -Left ([string] $stdoutRead.value.sha256) -Right ([string] $parsedResult.sha256))) { throw 'result-invalid' }
                    $result = $parsedResult; $evidence.resultSha256 = $result.sha256
                } catch { $evidence.resultDisposition = 'invalid' }
            }
            $auditRead = Read-IntentArcPreflightTerminalAuditProtectedDocument -RootGuard $attemptRoot -RootPath $attemptRootPath -Leaf 'audit-result.json' -MaximumBytes 16384 -Schema 'auditResult' -Guards $Guards
            $evidence.storedAuditDisposition = $auditRead.disposition
            if ($auditRead.disposition -ceq 'valid') {
                $evidence.storedAuditDisposition = 'present'; $evidence.storedAuditDocument = $auditRead.value.document
                $evidence.storedAuditBytesBase64 = [Convert]::ToBase64String([byte[]] $auditRead.value.bytes)
            } elseif ($auditRead.disposition -cne 'absent') { $evidence.storedAuditDisposition = 'invalid' }
        }
        $stateRootDisposition = Get-IntentArcPreflightAuditProbeDisposition ([IntentArc.PreflightEnvelope.EntryProbe]::Probe($preservationPath))
        if ($stateRootDisposition -ceq 'present') {
            $stateRoot = $null
            try {
                $stateRoot = [IntentArc.PreflightEnvelope.BoundaryGuard]::OpenDirectory($preservationPath, $preservationPath)
                if (-not [IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::ValidateProtection($stateRoot)) { throw 'state-root-invalid' }
                [void] $Guards.Add($stateRoot)
                $stateRead = Read-IntentArcPreflightTerminalAuditProtectedDocument -RootGuard $stateRoot -RootPath $preservationPath -Leaf ($script:IntentArcPreflightExecutionControllerRunId + '.json') -MaximumBytes 65536 -Schema 'id06State' -Guards $Guards
                $evidence.stateDisposition = $stateRead.disposition
                if ($stateRead.disposition -ceq 'valid') {
                    $state = $stateRead.value
                    if (-not (Test-IntentArcId06StateV2 -Document $state.document -ExpectedCommit $document.expectedCommit -PnpmPath $document.pnpmPath -PnpmSha256 $document.pnpmSha256 -SourcePath $sourcePath -DestinationPath $destinationPath -ProfilePath $profilePath -LocalAppDataPath $localAppDataPath)) { $evidence.stateDisposition = 'invalid'; $state = $null }
                    else { $evidence.stateSha256 = $state.sha256 }
                }
            } catch { $evidence.stateDisposition = 'invalid'; if ($null -ne $stateRoot -and -not $Guards.Contains($stateRoot)) { $stateRoot.Dispose() } }
        } elseif ($stateRootDisposition -ceq 'indeterminate') { $evidence.stateDisposition = 'invalid' }
        $receiptRootDisposition = Get-IntentArcPreflightAuditProbeDisposition ([IntentArc.PreflightEnvelope.EntryProbe]::Probe($receiptRootPath))
        if ($receiptRootDisposition -ceq 'present') {
            $receiptRoot = $null
            try {
                $receiptRoot = [IntentArc.PreflightEnvelope.BoundaryGuard]::OpenDirectory($receiptRootPath, $receiptRootPath)
                if (-not [IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::ValidateProtection($receiptRoot)) { throw 'receipt-root-invalid' }
                [void] $Guards.Add($receiptRoot)
                $id06Read = Read-IntentArcPreflightTerminalAuditProtectedDocument -RootGuard $receiptRoot -RootPath $receiptRootPath -Leaf ($script:IntentArcPreflightExecutionControllerRunId + '.json') -MaximumBytes 262144 -Schema 'id06Receipt' -Guards $Guards
                $evidence.id06ReceiptDisposition = $id06Read.disposition
                if ($id06Read.disposition -ceq 'valid') { $id06Receipt = $id06Read.value; $evidence.receiptSha256 = $id06Receipt.sha256 }
            } catch { $evidence.id06ReceiptDisposition = 'invalid'; if ($null -ne $receiptRoot -and -not $Guards.Contains($receiptRoot)) { $receiptRoot.Dispose() } }
        } elseif ($receiptRootDisposition -ceq 'indeterminate') { $evidence.id06ReceiptDisposition = 'invalid' }
        $evidence.journalBindingsValid = $null -ne $consumption -and
            ($null -eq $started -or ((Test-IntentArcPreflightExecutionFixedTimeText -Left $started.document.authorizationSha256 -Right $AuthorizationContext.Sha256) -and
                (Test-IntentArcPreflightExecutionFixedTimeText -Left $started.document.consumedSha256 -Right $consumption.sha256))) -and
            ($null -eq $attemptReceipt -or ((Test-IntentArcPreflightExecutionFixedText -Actual $attemptReceipt.document.attemptId -Expected $script:IntentArcPreflightExecutionAttemptId) -and
                (Test-IntentArcPreflightExecutionFixedText -Actual $attemptReceipt.document.controllerRunId -Expected $script:IntentArcPreflightExecutionControllerRunId)))
        if ($null -ne $attemptReceipt) {
            $evidence.receiptInfrastructureCategory = [string] $attemptReceipt.document.infrastructureCategory
            $evidence.controllerExitCode = if ($null -eq $attemptReceipt.document.controllerExitCode) { $null } else { [int] $attemptReceipt.document.controllerExitCode }
            $evidence.supervisorIdentityInvalidShape = $null -eq $started -and $attemptReceipt.document.infrastructureCategory -ceq 'settlement-invalid' -and
                $null -eq $attemptReceipt.document.controllerStartedAtUtc -and $null -eq $attemptReceipt.document.controllerProcessId -and
                $null -eq $attemptReceipt.document.controllerStartTimeUtc -and $null -eq $attemptReceipt.document.captureCompletedAtUtc -and
                $null -eq $attemptReceipt.document.controllerExitedAtUtc -and $null -eq $attemptReceipt.document.controllerExitCode -and
                $attemptReceipt.document.stdoutBytes -eq 0 -and $null -eq $attemptReceipt.document.stdoutSha256 -and
                $attemptReceipt.document.stderrBytes -eq 0 -and $null -eq $attemptReceipt.document.stderrSha256 -and
                -not $attemptReceipt.document.stdoutOverflow -and -not $attemptReceipt.document.stderrOverflow -and
                -not $attemptReceipt.document.stdoutEof -and -not $attemptReceipt.document.stderrEof -and -not $attemptReceipt.document.processSettled
            if ($null -ne $started) {
                $evidence.startedReceiptIdentityValid = $attemptReceipt.document.controllerProcessId -eq $started.document.controllerProcessId -and
                    (Test-IntentArcPreflightExecutionFixedText -Actual $attemptReceipt.document.controllerStartTimeUtc -Expected $started.document.controllerStartTimeUtc)
            }
        }
        if ($null -ne $attemptReceipt -and $null -ne $stdoutRead -and $stdoutRead.disposition -ceq 'valid' -and
            ($attemptReceipt.document.stdoutBytes -ne $stdoutRead.value.bytes.Length -or
             -not (Test-IntentArcPreflightExecutionFixedTimeText -Left ([string] $attemptReceipt.document.stdoutSha256) -Right ([string] $stdoutRead.value.sha256)))) {
            $evidence.controllerStdoutDisposition = 'invalid'
        }
        if ($null -ne $result) {
            $resultCandidate = $result.document.status -ceq 'PASS' -and $result.document.category -ceq 'none' -and
                $result.document.cleanupCategory -ceq 'none' -and $result.document.phase -ceq 'complete' -and
                $result.document.childStarted -and $result.document.childExitCode -eq 0 -and $result.document.outRestored
            $evidence.resultDisposition = if ($resultCandidate) { 'candidate' } else { 'not-candidate' }
        } elseif ($evidence.resultDisposition -cne 'invalid' -and $evidence.controllerStdoutDisposition -ceq 'invalid') { $evidence.resultDisposition = 'absent' }
        if ($evidence.resultDisposition -ceq 'candidate' -and $null -ne $state) {
            $stateAgrees = $state.document.phase -ceq 'complete' -and $state.document.recovery.mode -ceq 'none' -and
                $state.document.child.assignmentStatus -ceq 'assigned' -and $state.document.child.settlementStatus -ceq 'settled' -and
                $state.document.child.terminationReason -ceq 'normal-exit' -and $state.document.child.exitCode -eq $result.document.childExitCode -and
                $state.document.cleanup.localAppDataStatus -ceq 'removed' -and $state.document.cleanup.profileStatus -ceq 'removed' -and
                $state.document.cleanup.runRootStatus -ceq 'removed' -and $state.document.cleanup.category -ceq 'none'
            if (-not $stateAgrees) { $evidence.stateDisposition = 'invalid'; $state = $null }
        }
        if ($evidence.stateDisposition -ceq 'valid' -and $null -ne $id06Receipt -and $id06Receipt.document.status -cne 'passed') {
            $evidence.id06ReceiptDisposition = 'invalid'; $id06Receipt = $null
        }
        $evidence.jobDisposition = Get-IntentArcPreflightAuditProbeDisposition ([IntentArc.PreflightEnvelope.JobProbe]::Probe([string] $document.jobName))
        if ($null -ne $started) {
            $creation = [DateTimeOffset]::ParseExact([string] $started.document.controllerStartTimeUtc, "yyyy-MM-ddTHH:mm:ss.fff'Z'", [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal).UtcDateTime.ToFileTimeUtc()
            $probe = Get-IntentArcPreflightAuditProbeDisposition ([IntentArc.PreflightEnvelope.ProcessProbe]::ProbeAtMillisecondPrecision([int] $started.document.controllerProcessId, $creation))
            $evidence.controllerProcessDisposition = if ($probe -ceq 'absent') { 'reused' } else { $probe }
        }
        if ($null -ne $state -and $null -ne $state.document.child.rootProcessId -and $null -ne $state.document.child.rootStartTimeUtc) {
            $creation = [DateTimeOffset]::ParseExact([string] $state.document.child.rootStartTimeUtc, "yyyy-MM-ddTHH:mm:ss.fffffff'Z'", [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal).UtcDateTime.ToFileTimeUtc()
            $probe = Get-IntentArcPreflightAuditProbeDisposition ([IntentArc.PreflightEnvelope.ProcessProbe]::Probe([int] $state.document.child.rootProcessId, $creation))
            $evidence.childProcessDisposition = if ($probe -ceq 'absent') { 'reused' } else { $probe }
        }
        $evidence.settlementValid = $null -ne $attemptReceipt -and $null -ne $state -and $evidence.startedReceiptIdentityValid -and
            $attemptReceipt.document.infrastructureCategory -ceq 'none' -and $attemptReceipt.document.processSettled -and
            $attemptReceipt.document.stdoutEof -and $attemptReceipt.document.stderrEof -and -not $attemptReceipt.document.stdoutOverflow -and
            -not $attemptReceipt.document.stderrOverflow -and $state.document.child.settlementStatus -ceq 'settled' -and
            $state.document.child.exitCode -eq $result.document.childExitCode
        $rootGuard = $null; $sourceGuard = $null
        try {
            $rootGuard = [IntentArc.PreflightEnvelope.BoundaryGuard]::OpenDirectory($rootPath, $rootPath); [void] $Guards.Add($rootGuard)
            $sourceGuard = [IntentArc.PreflightEnvelope.BoundaryGuard]::OpenDirectoryForAudit($sourcePath, $sourcePath); [void] $Guards.Add($sourceGuard)
            $evidence.sourceFinalPathValid = $null -ne $state -and $sourceGuard.Revalidate() -and [string]::Equals([string] $state.document.directory.canonicalPath, $sourcePath, [StringComparison]::OrdinalIgnoreCase)
            $evidence.sourceStableIdentityValid = $evidence.sourceFinalPathValid -and [string]::Equals([string] $state.document.directory.stableIdentity, [string] $sourceGuard.StableIdentity, [StringComparison]::Ordinal)
            $evidence.sourceParentIdentityValid = $rootGuard.Revalidate() -and $sourceGuard.Revalidate() -and [string]::Equals([IO.Path]::GetDirectoryName($sourcePath), $rootPath, [StringComparison]::OrdinalIgnoreCase)
        } catch { $evidence.sourceFinalPathValid = $false; $evidence.sourceStableIdentityValid = $false; $evidence.sourceParentIdentityValid = $false }
        $evidence.destinationDisposition = Get-IntentArcPreflightAuditProbeDisposition ([IntentArc.PreflightEnvelope.EntryProbe]::Probe($destinationPath))
        $evidence.cleanupResidueDispositions = @(
            Get-IntentArcPreflightAuditProbeDisposition ([IntentArc.PreflightEnvelope.EntryProbe]::Probe($profilePath))
            Get-IntentArcPreflightAuditProbeDisposition ([IntentArc.PreflightEnvelope.EntryProbe]::Probe($localAppDataPath))
            Get-IntentArcPreflightAuditProbeDisposition ([IntentArc.PreflightEnvelope.EntryProbe]::Probe($runRootPath))
        )
        $bindingsValid = $true
        foreach ($binding in @(
            @('envelopePath','envelopeSha256'), @('controllerPath','controllerSha256'), @('gitPath','gitSha256'),
            @('nodePath','nodeSha256'), @('cmdPath','cmdSha256'), @('pnpmPath','pnpmSha256'), @('outerPowerShellPath','outerPowerShellSha256')
        )) {
            $bindingGuard = $null
            try {
                $bindingPath = [string] $document.($binding[0]); $bindingGuard = [IntentArc.PreflightEnvelope.BoundaryGuard]::OpenFile($bindingPath, $bindingPath)
                $bindingBytes = [byte[]] $bindingGuard.ReadAllBytes(268435456)
                if (-not $bindingGuard.Revalidate() -or -not (Test-IntentArcPreflightExecutionFixedTimeText -Left (Get-IntentArcPreflightExecutionSha256 -Bytes $bindingBytes) -Right ([string] $document.($binding[1])))) { $bindingsValid = $false }
                [void] $Guards.Add($bindingGuard); $bindingGuard = $null
            } catch { $bindingsValid = $false }
            finally { if ($null -ne $bindingGuard) { $bindingGuard.Dispose() } }
        }
        $evidence.bindingsDisposition = if ($bindingsValid) { 'valid' } else { 'invalid' }
        return $evidence
    } catch {
        $evidence.infrastructureValid = $false
        return $evidence
    }
}

function New-IntentArcPreflightTerminalAuditProductionOperations {
    param([Parameter(Mandatory)] $AuthorizationContext, $ExecutionState)
    Assert-IntentArcPreflightEnvelopeAuthorizationContext -AuthorizationContext $AuthorizationContext
    $guards = [Collections.Generic.List[IDisposable]]::new()
    $state = [pscustomobject]@{ RootGuard = $null }
    $capturedContext = $AuthorizationContext
    $capturedExecutionState = $ExecutionState
    $readEvidence = { param($document) Read-IntentArcPreflightTerminalAuditProductionEvidence -AuthorizationContext $capturedContext -Guards $guards -AuditState $state }.GetNewClosure()
    $observeGit = {
        param($document, $observation)
        $raw = Invoke-IntentArcPreflightGitObservation -AuthorizationDocument $document -Observation $observation
        return [pscustomobject][ordered]@{
            exitCode = $raw.exitCode
            stderrBytes = [int] $raw.stderrBytes
            overflow = $false
            stdout = [string] $raw.stdoutText
        }
    }.GetNewClosure()
    $writeAudit = {
        param($document, [byte[]] $auditBytes)
        if ($capturedContext.Invocation.mode -cne 'Execute' -or $null -eq $capturedExecutionState -or $null -eq $capturedExecutionState.RootGuard) { throw 'audit-write-invalid' }
        [void](Write-IntentArcPreflightEnvelopeImmutableBytes -RootGuard $capturedExecutionState.RootGuard -Leaf 'audit-result.json' -Bytes $auditBytes -MaximumBytes 16384)
        return [pscustomobject][ordered]@{ written = $true }
    }.GetNewClosure()
    $handlers = [ordered]@{
        ReadAuditEvidence = $readEvidence
        ObserveGit = $observeGit
        WriteAuditResult = $writeAudit
    }
    $operations = New-IntentArcPreflightTerminalAuditOperationMap -Handlers $handlers
    $dispose = {
        for ($index = $guards.Count - 1; $index -ge 0; $index--) { try { $guards[$index].Dispose() } catch {} }
        $guards.Clear(); $state.RootGuard = $null
    }.GetNewClosure()
    $operations | Add-Member -MemberType ScriptMethod -Name DisposeEvidenceGuards -Value $dispose -Force
    return $operations
}

function New-IntentArcPreflightTerminalAuditOperations {
    param([Parameter(Mandatory)][Collections.IDictionary] $Handlers)
    if (-not $script:IntentArcPreflightEnvelopeWasDotSourced -or $args.Count -ne 0 -or
        $Handlers.Count -ne $script:IntentArcPreflightTerminalAuditOperationNames.Count) { throw 'audit-operation-map-invalid' }
    return New-IntentArcPreflightTerminalAuditOperationMap -Handlers $Handlers
}

function New-IntentArcPreflightTerminalAuditOperationMap {
    param([Parameter(Mandatory)][Collections.IDictionary] $Handlers)
    if ($args.Count -ne 0 -or $Handlers.Count -ne $script:IntentArcPreflightTerminalAuditOperationNames.Count) { throw 'audit-operation-map-invalid' }
    $result = [ordered]@{}
    foreach ($name in $script:IntentArcPreflightTerminalAuditOperationNames) {
        if (-not $Handlers.Contains($name) -or $Handlers[$name] -isnot [scriptblock]) { throw 'audit-operation-map-invalid' }
        $result[$name] = $Handlers[$name]
    }
    foreach ($name in @($Handlers.Keys)) {
        if ($name -isnot [string] -or -not ($script:IntentArcPreflightTerminalAuditOperationNames -ccontains $name)) { throw 'audit-operation-map-invalid' }
    }
    $operations = [pscustomobject] $result
    $operations | Add-Member -MemberType ScriptMethod -Name DisposeEvidenceGuards -Value { }
    return $operations
}

function Assert-IntentArcPreflightTerminalAuditOperations {
    param([Parameter(Mandatory)] $Operations)
    if (-not (Test-IntentArcPreflightEnvelopeOrderedPropertyNames -Value $Operations -Expected $script:IntentArcPreflightTerminalAuditOperationNames)) {
        throw 'audit-operation-map-invalid'
    }
    foreach ($name in $script:IntentArcPreflightTerminalAuditOperationNames) {
        if ($Operations.$name -isnot [scriptblock]) { throw 'audit-operation-map-invalid' }
    }
    if ($null -eq $Operations.PSObject.Methods['DisposeEvidenceGuards']) { throw 'audit-operation-map-invalid' }
}

function Test-IntentArcPreflightTerminalAuditEvidence {
    param([Parameter(Mandatory)] $Evidence)
    try {
        $keys = @(
            'attemptRootDisposition', 'authorizationCopyValid', 'consumptionDisposition', 'controllerStartedDisposition',
            'attemptReceiptDisposition', 'journalBindingsValid', 'startedReceiptIdentityValid', 'supervisorIdentityInvalidShape',
            'receiptInfrastructureCategory', 'controllerExitCode', 'controllerStdoutDisposition', 'resultDisposition',
            'resultSha256', 'stateDisposition', 'stateSha256', 'id06ReceiptDisposition', 'receiptSha256', 'jobDisposition',
            'controllerProcessDisposition', 'childProcessDisposition', 'settlementValid', 'sourceFinalPathValid',
            'sourceStableIdentityValid', 'sourceParentIdentityValid', 'destinationDisposition', 'cleanupResidueDispositions',
            'bindingsDisposition', 'infrastructureValid', 'storedAuditDisposition', 'storedAuditDocument', 'storedAuditBytesBase64'
        )
        if (-not (Test-IntentArcPreflightEnvelopeOrderedPropertyNames -Value $Evidence -Expected $keys)) { return $false }
        foreach ($name in @('authorizationCopyValid','journalBindingsValid','startedReceiptIdentityValid','supervisorIdentityInvalidShape','settlementValid','sourceFinalPathValid','sourceStableIdentityValid','sourceParentIdentityValid','infrastructureValid')) {
            if ($Evidence.$name -isnot [bool]) { return $false }
        }
        $closed = [ordered]@{
            attemptRootDisposition = @('absent','present','indeterminate')
            consumptionDisposition = @('absent','valid','invalid')
            controllerStartedDisposition = @('absent','valid','invalid')
            attemptReceiptDisposition = @('absent','valid','invalid')
            controllerStdoutDisposition = @('absent','valid','invalid')
            resultDisposition = @('absent','candidate','not-candidate','invalid')
            stateDisposition = @('absent','valid','invalid')
            id06ReceiptDisposition = @('absent','valid','invalid')
            jobDisposition = @('absent','present','indeterminate')
            controllerProcessDisposition = @('absent','reused','present','indeterminate','not-applicable')
            childProcessDisposition = @('absent','reused','present','indeterminate','not-applicable')
            destinationDisposition = @('absent','present','indeterminate')
            bindingsDisposition = @('valid','invalid','indeterminate')
            storedAuditDisposition = @('absent','present','invalid','indeterminate')
        }
        foreach ($name in $closed.Keys) {
            if ($Evidence.$name -isnot [string] -or $closed[$name] -cnotcontains $Evidence.$name) { return $false }
        }
        if ($null -ne $Evidence.receiptInfrastructureCategory -and
            ($Evidence.receiptInfrastructureCategory -isnot [string] -or @('none','launch-failed','consumption-journal-invalid','capture-overflow','capture-invalid','settlement-invalid') -cnotcontains $Evidence.receiptInfrastructureCategory)) { return $false }
        if ($null -ne $Evidence.controllerExitCode -and -not (Test-IntentArcPreflightClosedInteger -Value $Evidence.controllerExitCode -Minimum ([int]::MinValue) -Maximum ([int]::MaxValue))) { return $false }
        foreach ($name in @('resultSha256','stateSha256','receiptSha256')) {
            if ($null -ne $Evidence.$name -and ($Evidence.$name -isnot [string] -or $Evidence.$name -cnotmatch '^[a-f0-9]{64}$')) { return $false }
        }
        $residue = @($Evidence.cleanupResidueDispositions)
        if ($residue.Count -ne 3) { return $false }
        foreach ($item in $residue) { if ($item -isnot [string] -or @('absent','present','indeterminate') -cnotcontains $item) { return $false } }
        if ($Evidence.storedAuditDisposition -ceq 'present') {
            if ($Evidence.storedAuditDocument -isnot [pscustomobject] -or $Evidence.storedAuditBytesBase64 -isnot [string]) { return $false }
        } elseif ($null -ne $Evidence.storedAuditDocument -or $null -ne $Evidence.storedAuditBytesBase64) { return $false }
        return $true
    } catch { return $false }
}

function Test-IntentArcPreflightTerminalAuditGitResult {
    param([Parameter(Mandatory)] $Result, [Parameter(Mandatory)][string] $Observation, [Parameter(Mandatory)] $AuthorizationDocument)
    if (-not (Test-IntentArcPreflightEnvelopeOrderedPropertyNames -Value $Result -Expected @('exitCode','stderrBytes','overflow','stdout')) -or
        -not (Test-IntentArcPreflightClosedInteger -Value $Result.exitCode -Minimum ([int]::MinValue) -Maximum ([int]::MaxValue)) -or
        $Result.stderrBytes -isnot [int] -or $Result.stderrBytes -lt 0 -or $Result.overflow -isnot [bool] -or $Result.stdout -isnot [string] -or
        $Result.exitCode -ne 0 -or $Result.stderrBytes -ne 0 -or $Result.overflow) { return $false }
    if ($Observation -ceq 'root') {
        $rootText = $Result.stdout.TrimEnd([char[]]@("`r", "`n"))
        if (-not ($Result.stdout.EndsWith("`n", [StringComparison]::Ordinal)) -or $rootText.IndexOfAny([char[]]@("`r", "`n")) -ge 0) { return $false }
        try {
            return [string]::Equals([IO.Path]::GetFullPath($rootText), [IO.Path]::GetFullPath([string] $AuthorizationDocument.canonicalPath), [StringComparison]::OrdinalIgnoreCase)
        } catch { return $false }
    }
    $expected = switch -CaseSensitive ($Observation) {
        'branch' { 'master'; break }
        'head' { [string] $AuthorizationDocument.expectedCommit; break }
        'status' { ''; break }
        default { return $false }
    }
    if ($Observation -ceq 'status') { return $Result.stdout -ceq '' }
    return $Result.stdout -ceq ($expected + "`n") -or $Result.stdout -ceq ($expected + "`r`n")
}

function New-IntentArcPreflightTerminalAuditProjection {
    param(
        [Parameter(Mandatory)][string] $Category,
        [AllowNull()][string] $ExpectedCommit,
        [Parameter(Mandatory)] $Evidence,
        [Parameter(Mandatory)][bool] $ControllerStarted
    )
    $result = [ordered]@{
        schema = 'intentarc.preflight-execution-audit/v1'
        status = if ($Category -ceq 'none') { 'AUDITED-PASS' } else { 'TERMINAL-NOT-PASS' }
        category = $Category
        attemptId = $script:IntentArcPreflightExecutionAttemptId
        controllerRunId = $script:IntentArcPreflightExecutionControllerRunId
        expectedCommit = $ExpectedCommit
        attemptConsumed = $false
        controllerStarted = $false
        controllerExitCode = $null
        resultSha256 = $null
        stateSha256 = $null
        receiptSha256 = $null
        outRestored = $false
        cleanupComplete = $false
        gitClean = $false
        bindingsValid = $false
    }
    if ($Category -ceq 'authorization-invalid') { $result.expectedCommit = $null; return $result }
    if ($Category -ceq 'attempt-not-consumed' -or $Category -ceq 'attempt-evidence-invalid' -or $Category -ceq 'audit-infrastructure-invalid') { return $result }
    $result.attemptConsumed = $true
    if ($Category -ceq 'controller-not-started') { return $result }
    $result.controllerStarted = $ControllerStarted
    if ($Category -ceq 'controller-outcome-uncertain') { return $result }
    if ($null -ne $Evidence.controllerExitCode) { $result.controllerExitCode = [int] $Evidence.controllerExitCode }
    if ($Category -ceq 'controller-capture-invalid' -or $Category -ceq 'controller-result-invalid') { return $result }
    if ($null -ne $Evidence.resultSha256) { $result.resultSha256 = [string] $Evidence.resultSha256 }
    if ($Category -ceq 'controller-state-invalid') { return $result }
    if ($null -ne $Evidence.stateSha256) { $result.stateSha256 = [string] $Evidence.stateSha256 }
    if ($Category -ceq 'controller-receipt-invalid') { return $result }
    if ($null -ne $Evidence.receiptSha256) { $result.receiptSha256 = [string] $Evidence.receiptSha256 }
    if ($Category -ceq 'child-settlement-invalid' -or $Category -ceq 'out-restoration-invalid') { return $result }
    $result.outRestored = $true
    if ($Category -ceq 'cleanup-invalid') { return $result }
    $result.cleanupComplete = $true
    if ($Category -ceq 'repository-invalid') { return $result }
    $result.gitClean = $true
    if ($Category -ceq 'binding-invalid') { return $result }
    $result.bindingsValid = $true
    return $result
}

function Get-IntentArcPreflightTerminalAuditCategory {
    param([Parameter(Mandatory)] $Evidence, [Parameter(Mandatory)][bool] $GitClean)
    $allJournalAbsent = $Evidence.consumptionDisposition -ceq 'absent' -and $Evidence.controllerStartedDisposition -ceq 'absent' -and $Evidence.attemptReceiptDisposition -ceq 'absent'
    $launchFailureShape = $Evidence.controllerStartedDisposition -ceq 'absent' -and $Evidence.attemptReceiptDisposition -ceq 'valid' -and $Evidence.receiptInfrastructureCategory -ceq 'launch-failed'
    $supervisorIdentityShape = $Evidence.controllerStartedDisposition -ceq 'absent' -and $Evidence.attemptReceiptDisposition -ceq 'valid' -and
        $Evidence.receiptInfrastructureCategory -ceq 'settlement-invalid' -and $Evidence.supervisorIdentityInvalidShape
    $startedAndReceipt = $Evidence.controllerStartedDisposition -ceq 'valid' -and $Evidence.attemptReceiptDisposition -ceq 'valid' -and $Evidence.startedReceiptIdentityValid
    $cleanupInvalid = $false
    foreach ($disposition in @($Evidence.cleanupResidueDispositions)) { if ($disposition -cne 'absent') { $cleanupInvalid = $true } }
    $faults = [ordered]@{
        'authorization-invalid' = $false
        'attempt-not-consumed' = $Evidence.attemptRootDisposition -ceq 'absent' -or
            ($Evidence.attemptRootDisposition -ceq 'present' -and $Evidence.authorizationCopyValid -and $allJournalAbsent)
        'attempt-evidence-invalid' = $Evidence.attemptRootDisposition -cne 'present' -or -not $Evidence.authorizationCopyValid -or
            $Evidence.consumptionDisposition -cne 'valid' -or $Evidence.controllerStartedDisposition -ceq 'invalid' -or
            $Evidence.attemptReceiptDisposition -ceq 'invalid' -or -not $Evidence.journalBindingsValid -or
            ($Evidence.controllerStartedDisposition -ceq 'absent' -and $Evidence.attemptReceiptDisposition -ceq 'valid' -and -not $launchFailureShape -and -not $supervisorIdentityShape) -or
            ($Evidence.controllerStartedDisposition -ceq 'valid' -and $Evidence.attemptReceiptDisposition -ceq 'valid' -and -not $Evidence.startedReceiptIdentityValid) -or
            ($Evidence.controllerStartedDisposition -ceq 'valid' -and @('consumption-journal-invalid','launch-failed') -ccontains $Evidence.receiptInfrastructureCategory) -or
            ($Evidence.supervisorIdentityInvalidShape -and -not $supervisorIdentityShape) -or
            ($startedAndReceipt -and $Evidence.receiptInfrastructureCategory -ceq 'none' -and $null -eq $Evidence.controllerExitCode)
        'controller-not-started' = $launchFailureShape -and $Evidence.jobDisposition -ceq 'absent'
        'controller-outcome-uncertain' = ($Evidence.consumptionDisposition -ceq 'valid' -and $Evidence.attemptReceiptDisposition -ceq 'absent') -or
            ($launchFailureShape -and $Evidence.jobDisposition -cne 'absent') -or $supervisorIdentityShape -or
            ($startedAndReceipt -and $Evidence.receiptInfrastructureCategory -ceq 'settlement-invalid')
        'controller-capture-invalid' = $startedAndReceipt -and
            (@('capture-invalid','capture-overflow') -ccontains $Evidence.receiptInfrastructureCategory -or $Evidence.controllerStdoutDisposition -cne 'valid')
        'controller-result-invalid' = -not $startedAndReceipt -or $Evidence.receiptInfrastructureCategory -cne 'none' -or
            $null -eq $Evidence.controllerExitCode -or $Evidence.controllerExitCode -ne 0 -or $Evidence.resultDisposition -cne 'candidate' -or
            $null -eq $Evidence.resultSha256
        'controller-state-invalid' = $Evidence.stateDisposition -cne 'valid' -or $null -eq $Evidence.stateSha256
        'controller-receipt-invalid' = $Evidence.id06ReceiptDisposition -cne 'valid' -or $null -eq $Evidence.receiptSha256
        'child-settlement-invalid' = -not $Evidence.settlementValid -or
            @('present','indeterminate') -ccontains $Evidence.jobDisposition -or
            $Evidence.controllerProcessDisposition -cne 'reused' -or $Evidence.childProcessDisposition -cne 'reused'
        'out-restoration-invalid' = -not $Evidence.sourceFinalPathValid -or -not $Evidence.sourceStableIdentityValid -or
            -not $Evidence.sourceParentIdentityValid -or $Evidence.destinationDisposition -cne 'absent'
        'cleanup-invalid' = $cleanupInvalid
        'repository-invalid' = -not $GitClean
        'binding-invalid' = $Evidence.bindingsDisposition -cne 'valid'
        'audit-infrastructure-invalid' = -not $Evidence.infrastructureValid
    }
    foreach ($category in $script:IntentArcPreflightAuditPrecedence) {
        if ($faults[$category]) { return $category }
    }
    return 'none'
}

function Invoke-IntentArcPreflightTerminalAudit {
    param([AllowNull()][Parameter(Mandatory)] $AuthorizationContext, [AllowNull()][Parameter(Mandatory)] $Operations, [switch] $SuppressWrite, [switch] $ExecuteFailed)
    try {
        Assert-IntentArcPreflightEnvelopeAuthorizationContext -AuthorizationContext $AuthorizationContext
    } catch { return New-IntentArcPreflightExecutionAuthorizationRefusal }
    $expectedCommit = [string] $AuthorizationContext.Document.expectedCommit
    try {
        Assert-IntentArcPreflightTerminalAuditOperations -Operations $Operations
    } catch {
        return New-IntentArcPreflightTerminalAuditProjection -Category 'audit-infrastructure-invalid' -ExpectedCommit $expectedCommit -Evidence (New-IntentArcPreflightTerminalAuditEvidence) -ControllerStarted $false
    }
    $evidence = $null
    $gitClean = $true
    try {
        $items = @($Operations.ReadAuditEvidence.Invoke($AuthorizationContext.Document))
        if ($items.Count -ne 1 -or -not (Test-IntentArcPreflightTerminalAuditEvidence -Evidence $items[0])) { throw 'audit-evidence-invalid' }
        $evidence = $items[0]
        foreach ($observation in @('root','branch','head','status')) {
            try {
                $gitItems = @($Operations.ObserveGit.Invoke($AuthorizationContext.Document, $observation))
                if ($gitItems.Count -ne 1 -or -not (Test-IntentArcPreflightTerminalAuditGitResult -Result $gitItems[0] -Observation $observation -AuthorizationDocument $AuthorizationContext.Document)) { $gitClean = $false }
            } catch { $gitClean = $false }
        }
        $category = Get-IntentArcPreflightTerminalAuditCategory -Evidence $evidence -GitClean $gitClean
        $controllerStarted = $evidence.controllerStartedDisposition -ceq 'valid' -and $evidence.attemptReceiptDisposition -ceq 'valid' -and $evidence.startedReceiptIdentityValid
        $projection = New-IntentArcPreflightTerminalAuditProjection -Category $category -ExpectedCommit $expectedCommit -Evidence $evidence -ControllerStarted $controllerStarted
        $canonicalBytes = ConvertTo-IntentArcPreflightEnvelopeCanonicalBytes -Document $projection
        if ($evidence.storedAuditDisposition -ceq 'present') {
            $storedValid = $false
            try {
                $storedBytes = [Convert]::FromBase64String([string] $evidence.storedAuditBytesBase64)
                $storedValid = $storedBytes.Length -ge 1 -and $storedBytes.Length -le 16384 -and
                    (Test-IntentArcPreflightAuditResult -Document $evidence.storedAuditDocument) -and
                    (Test-IntentArcPreflightEnvelopeFixedBytes -Left $storedBytes -Right (ConvertTo-IntentArcPreflightEnvelopeCanonicalBytes -Document $evidence.storedAuditDocument)) -and
                    (Test-IntentArcPreflightEnvelopeFixedBytes -Left $storedBytes -Right $canonicalBytes)
            } catch { $storedValid = $false }
            if (-not $storedValid) {
                $projection = New-IntentArcPreflightTerminalAuditProjection -Category 'attempt-evidence-invalid' -ExpectedCommit $expectedCommit -Evidence $evidence -ControllerStarted $false
                $canonicalBytes = ConvertTo-IntentArcPreflightEnvelopeCanonicalBytes -Document $projection
            }
        } elseif ($evidence.storedAuditDisposition -cne 'absent') {
            $projection = New-IntentArcPreflightTerminalAuditProjection -Category 'attempt-evidence-invalid' -ExpectedCommit $expectedCommit -Evidence $evidence -ControllerStarted $false
            $canonicalBytes = ConvertTo-IntentArcPreflightEnvelopeCanonicalBytes -Document $projection
        }
        # A failed invocation cannot emit or persist a positive projection from retained evidence.
        if ($ExecuteFailed -and $projection.status -ceq 'AUDITED-PASS') {
            $projection = New-IntentArcPreflightTerminalAuditProjection -Category 'audit-infrastructure-invalid' -ExpectedCommit $expectedCommit -Evidence (New-IntentArcPreflightTerminalAuditEvidence) -ControllerStarted $false
            $canonicalBytes = ConvertTo-IntentArcPreflightEnvelopeCanonicalBytes -Document $projection
        }
        $projectionDocument = [Text.UTF8Encoding]::new($false, $true).GetString($canonicalBytes) | ConvertFrom-Json -ErrorAction Stop
        if (-not (Test-IntentArcPreflightAuditResult -Document $projectionDocument)) {
            $projection = New-IntentArcPreflightTerminalAuditProjection -Category 'audit-infrastructure-invalid' -ExpectedCommit $expectedCommit -Evidence $evidence -ControllerStarted $false
            $canonicalBytes = ConvertTo-IntentArcPreflightEnvelopeCanonicalBytes -Document $projection
            $projectionDocument = [Text.UTF8Encoding]::new($false, $true).GetString($canonicalBytes) | ConvertFrom-Json -ErrorAction Stop
            if (-not (Test-IntentArcPreflightAuditResult -Document $projectionDocument)) { throw 'audit-projection-invalid' }
        }
        if (-not $SuppressWrite -and $AuthorizationContext.Invocation.mode -ceq 'Execute' -and $evidence.storedAuditDisposition -ceq 'absent' -and
            $projection.category -cne 'audit-infrastructure-invalid') {
            $writeItems = @($Operations.WriteAuditResult.Invoke($AuthorizationContext.Document, $canonicalBytes))
            if ($writeItems.Count -ne 1 -or -not (Test-IntentArcPreflightEnvelopeOrderedPropertyNames -Value $writeItems[0] -Expected @('written')) -or
                $writeItems[0].written -isnot [bool] -or -not $writeItems[0].written) {
                return New-IntentArcPreflightTerminalAuditProjection -Category 'audit-infrastructure-invalid' -ExpectedCommit $expectedCommit -Evidence $evidence -ControllerStarted $false
            }
        }
        return $projection
    } catch {
        if ($null -eq $evidence) {
            $evidence = [pscustomobject]@{ controllerExitCode = $null; resultSha256 = $null; stateSha256 = $null; receiptSha256 = $null }
        }
        return New-IntentArcPreflightTerminalAuditProjection -Category 'audit-infrastructure-invalid' -ExpectedCommit $expectedCommit -Evidence $evidence -ControllerStarted $false
    }
}

function Invoke-IntentArcPreflightEnvelopeAuditOnly {
    param([AllowNull()][Parameter(Mandatory)] $AuthorizationContext, [AllowNull()][Parameter(Mandatory)] $Operations)
    try {
        Assert-IntentArcPreflightEnvelopeAuthorizationContext -AuthorizationContext $AuthorizationContext
        if ($AuthorizationContext.Invocation.mode -cne 'AuditOnly') { throw 'authorization-context-invalid' }
    } catch { return New-IntentArcPreflightExecutionAuthorizationRefusal }
    return Invoke-IntentArcPreflightTerminalAudit -AuthorizationContext $AuthorizationContext -Operations $Operations
}

function Invoke-IntentArcPreflightControllerLaunch {
    param([Parameter(Mandatory)] $StartInfo, [Parameter(Mandatory)] $Bindings, [Parameter(Mandatory)] $Gate)
    return [IntentArc.PreflightEnvelope.NativeProcessDispatcher]::Run([IntentArc.PreflightEnvelope.ProcessRole]::Controller, $StartInfo, $Bindings, $Gate, $null)
}

function New-IntentArcPreflightEnvelopeProductionOperations {
    param([Parameter(Mandatory)] $AuthorizationContext)
    Assert-IntentArcPreflightEnvelopeAuthorizationContext -AuthorizationContext $AuthorizationContext
    $context = $AuthorizationContext
    $controllerRunId = $script:IntentArcPreflightExecutionControllerRunId
    $guards = [Collections.Generic.List[IDisposable]]::new()
    $state = [pscustomobject]@{ RootGuard = $null; Gate = $null; AttemptedAt = $null }
    $handlers = [ordered]@{
        BindExecutionInputs = {
            param($document)
            [void](Read-IntentArcPreflightEnvelopeRetainedManifestBytes -AuthorizationContext $context)
            foreach ($name in @('envelope','controller','git','node','cmd','pnpm','host')) {
                $pathKey = if ($name -ceq 'host') { 'outerPowerShellPath' } else { $name + 'Path' }
                $hashKey = if ($name -ceq 'host') { 'outerPowerShellSha256' } else { $name + 'Sha256' }
                $digest = Get-IntentArcPreflightExecutionPinnedFileSha256 -LiteralPath $document.$pathKey -ExpectedFinalPath $document.$pathKey -Contract $context.Contract -Purpose $name -OwnerGuard $context.ManifestGuard
                if (-not (Test-IntentArcPreflightExecutionFixedTimeText -Left $digest -Right $document.$hashKey)) { throw 'binding-invalid' }
            }
            [pscustomobject][ordered]@{ valid = $true }
        }.GetNewClosure()
        GetRepositoryState = {
            param($document)
            foreach ($observation in @('root','branch','head','status')) {
                $raw = Invoke-IntentArcPreflightGitObservation -AuthorizationDocument $document -Observation $observation
                $record = [pscustomobject][ordered]@{ exitCode=$raw.exitCode; stderrBytes=[int]$raw.stderrBytes; overflow=$false; stdout=$raw.stdoutText }
                if (-not (Test-IntentArcPreflightTerminalAuditGitResult -Result $record -Observation $observation -AuthorizationDocument $document)) { throw 'repository-invalid' }
            }
            [pscustomobject][ordered]@{ valid = $true }
        }.GetNewClosure()
        GuardBoundaries = {
            param($document)
            foreach ($relative in @('', '.superpowers', '.superpowers\preflight-execution-envelope', '.superpowers\preflight-out-preservation', '.superpowers\preflight', '.superpowers\preflight\desktop-release')) {
                $path = if ($relative -ceq '') { $context.Contract.Root } else { Join-Path $context.Contract.Root $relative }
                $guard = [IntentArc.PreflightEnvelope.BoundaryGuard]::OpenDirectory($path, $path)
                [void]$guards.Add($guard)
                if (-not $guard.Revalidate()) { throw 'boundary-invalid' }
            }
            $outPath = Join-Path $context.Contract.Root 'out'
            $outGuard = [IntentArc.PreflightEnvelope.BoundaryGuard]::OpenDirectoryForAudit($outPath, $outPath)
            [pscustomobject][ordered]@{ valid = $true; outGuard = $outGuard }
        }.GetNewClosure()
        ProbeId06Unused = {
            param($document)
            $preservation = Join-Path $context.Contract.Root '.superpowers\preflight-out-preservation'
            $receiptParent = Join-Path $context.Contract.Root '.superpowers\preflight\desktop-release'
            $runRoot = Join-Path $preservation $controllerRunId
            foreach ($path in @((Join-Path $preservation ($controllerRunId + '.json')), (Join-Path $receiptParent ($controllerRunId + '.json')), $runRoot, (Join-Path $runRoot 'out'))) {
                if ([IntentArc.PreflightEnvelope.EntryProbe]::Probe($path) -ne [IntentArc.PreflightEnvelope.ProbeDisposition]::Absent) { throw 'namespace-invalid' }
            }
            if ([IntentArc.PreflightEnvelope.JobProbe]::Probe($document.jobName) -ne [IntentArc.PreflightEnvelope.ProbeDisposition]::Absent) { throw 'job-invalid' }
            [pscustomobject][ordered]@{ unused = $true }
        }.GetNewClosure()
        CreateAttemptRoot = {
            param($document)
            $state.RootGuard = New-IntentArcPreflightEnvelopeAttemptRoot -AuthorizationContext $context
            [void]$guards.Add($state.RootGuard)
            [pscustomobject][ordered]@{ created = $true }
        }.GetNewClosure()
        CopyAuthorization = {
            param($document)
            Copy-IntentArcPreflightEnvelopeAuthorization -AuthorizationContext $context -RootGuard $state.RootGuard
        }.GetNewClosure()
        WriteConsumptionAttempted = {
            param($document)
            $consumed = Write-IntentArcPreflightEnvelopeConsumptionAttempted -AuthorizationContext $context -RootGuard $state.RootGuard
            Assert-IntentArcPreflightEnvelopeShaRecord -Record $consumed
            $state.Gate = New-IntentArcPreflightControllerLaunchGate -DurableConsumptionValidated $true
            $consumed
        }.GetNewClosure()
        StartController = {
            param($document)
            $info = New-IntentArcPreflightControllerStartInfo -AuthorizationDocument $document
            $bindings = New-IntentArcPreflightControllerLaunchBindings -AuthorizationDocument $document
            $state.AttemptedAt = [DateTimeOffset]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fff'Z'", [Globalization.CultureInfo]::InvariantCulture)
            Invoke-IntentArcPreflightControllerLaunch -StartInfo $info -Bindings $bindings -Gate $state.Gate
        }.GetNewClosure()
        WriteControllerStarted = {
            param($document,$consumedSha256,$processId,$startTimeUtc)
            Write-IntentArcPreflightEnvelopeControllerStarted -AuthorizationContext $context -RootGuard $state.RootGuard -ConsumedSha256 $consumedSha256 -ProcessId $processId -StartTimeUtc $startTimeUtc
        }.GetNewClosure()
        FinalizeControllerAttempt = {
            param($document,$launch,$controllerStartedValid)
            if ($null -eq $launch) { throw 'controller-outcome-uncertain' }
            Finalize-IntentArcPreflightControllerAttempt -RootGuard $state.RootGuard -Launch $launch -ControllerStartedValid $controllerStartedValid -LaunchAttemptedAtUtc $state.AttemptedAt
        }.GetNewClosure()
    }
    $execute = New-IntentArcPreflightEnvelopeOperationMap -Handlers $handlers
    $dispose = { for ($index=$guards.Count-1; $index-ge0; $index--) { try {$guards[$index].Dispose()} catch {} }; $guards.Clear() }.GetNewClosure()
    $execute | Add-Member -MemberType ScriptMethod -Name DisposeBoundaryGuards -Value $dispose
    $ownsAttemptRoot = { return $null -ne $state.RootGuard }.GetNewClosure()
    $execute | Add-Member -MemberType ScriptMethod -Name OwnsAttemptRoot -Value $ownsAttemptRoot
    return [pscustomobject][ordered]@{ Execute = $execute; Audit = New-IntentArcPreflightTerminalAuditProductionOperations -AuthorizationContext $context -ExecutionState $state }
}

function Invoke-IntentArcPreflightEnvelopeHost {
    param([AllowNull()][Parameter(Mandatory)] $Invocation, $Contract, $Operations)
    $context = $null; $result = $null
    try {
        if ($args.Count -ne 0 -or $null -eq $Invocation -or ($PSBoundParameters.ContainsKey('Contract') -xor $PSBoundParameters.ContainsKey('Operations'))) { throw 'authorization-invalid' }
        if ($PSBoundParameters.ContainsKey('Contract')) {
            if (-not $script:IntentArcPreflightEnvelopeWasDotSourced -or -not (Test-IntentArcPreflightEnvelopeInternalContract $Contract)) { throw 'authorization-invalid' }
        } else { $Contract = New-IntentArcPreflightEnvelopeProductionContract }
        $context = Read-IntentArcPreflightExecutionAuthorizationManifest -LiteralPath $Invocation.manifestPath -ExpectedSha256 $Invocation.expectedSha256 -ActualInvocation $Invocation -Contract $Contract
        if (-not $PSBoundParameters.ContainsKey('Operations')) {
            if ($Invocation.mode -ceq 'Execute') { $Operations = New-IntentArcPreflightEnvelopeProductionOperations -AuthorizationContext $context }
            else { $Operations = [pscustomobject][ordered]@{ Execute=$null; Audit=New-IntentArcPreflightTerminalAuditProductionOperations -AuthorizationContext $context } }
        }
        if (-not (Test-IntentArcPreflightEnvelopeOrderedPropertyNames -Value $Operations -Expected @('Execute','Audit'))) { throw 'audit-infrastructure-invalid' }
        if ($Invocation.mode -ceq 'Execute') {
            $executeFailed = $false
            try { [void](Invoke-IntentArcPreflightEnvelopeExecute -AuthorizationContext $context -Operations $Operations.Execute) } catch { $executeFailed = $true }
            $ownsAttemptRoot = $null -ne $Operations.Execute.PSObject.Methods['OwnsAttemptRoot'] -and $Operations.Execute.OwnsAttemptRoot()
            $result = Invoke-IntentArcPreflightTerminalAudit -AuthorizationContext $context -Operations $Operations.Audit -SuppressWrite:(-not $ownsAttemptRoot) -ExecuteFailed:$executeFailed
        } elseif ($Invocation.mode -ceq 'AuditOnly') {
            $result = Invoke-IntentArcPreflightEnvelopeAuditOnly -AuthorizationContext $context -Operations $Operations.Audit
        } else { throw 'authorization-invalid' }
    } catch {
        if ($null -eq $context) { $result = New-IntentArcPreflightExecutionAuthorizationRefusal }
        else { $result = New-IntentArcPreflightTerminalAuditProjection -Category 'audit-infrastructure-invalid' -ExpectedCommit $context.Document.expectedCommit -Evidence (New-IntentArcPreflightTerminalAuditEvidence) -ControllerStarted $false }
    } finally {
        if ($null -ne $Operations) {
            foreach ($name in @('Execute','Audit')) {
                try {
                    $map = $Operations.$name
                    if ($null -ne $map) {
                        $map.DisposeEvidenceGuards()
                        if ($null -ne $map.PSObject.Methods['DisposeBoundaryGuards']) { $map.DisposeBoundaryGuards() }
                    }
                } catch {}
            }
        }
        if ($null -ne $context) { try {$context.Dispose()} catch {} }
    }
    return $result
}

function Get-IntentArcPreflightEnvelopeSourceCallInventory {
    param([Parameter(Mandatory)][Management.Automation.Language.ScriptBlockAst] $Ast)
    # Complete token streams retain every executable leaf and control-flow statement, not just calls.
    $inventory = [Collections.Generic.Dictionary[string,Collections.Generic.List[string]]]::new([StringComparer]::Ordinal)
    $inventory.Add('<top>', [Collections.Generic.List[string]]::new())
    $definitions = @($Ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst]}, $true))
    foreach ($definition in $definitions) {
        if ($inventory.ContainsKey($definition.Name)) { throw 'source-structure-invalid' }
        $inventory.Add($definition.Name, [Collections.Generic.List[string]]::new())
    }
    # Mask only literal SHA256 values in the policy's one approved-data hashtable.
    # Keys, assignment, table structure, and any added executable expressions remain fingerprinted.
    $maskedOffsets = [Collections.Generic.HashSet[int]]::new()
    $policy = @($definitions | Where-Object { $_.Name -ceq 'Test-IntentArcPreflightEnvelopeSourcePolicy' })
    if ($policy.Count -ne 1) { throw 'source-structure-invalid' }
    $assignments = @($policy[0].Body.FindAll({param($node)
        $node -is [Management.Automation.Language.AssignmentStatementAst] -and $node.Left.Extent.Text -ceq '$approved'
    }, $true))
    if ($assignments.Count -ne 1) { throw 'source-structure-invalid' }
    $tables = @($assignments[0].Right.FindAll({param($node) $node -is [Management.Automation.Language.HashtableAst]}, $true))
    if ($tables.Count -ne 1) { throw 'source-structure-invalid' }
    foreach ($pair in $tables[0].KeyValuePairs) {
        $statement = $pair.Item2
        if ($statement -isnot [Management.Automation.Language.PipelineAst] -or
            $statement.PipelineElements.Count -ne 1 -or $statement.PipelineElements[0] -isnot [Management.Automation.Language.CommandExpressionAst]) { throw 'source-structure-invalid' }
        $value = $statement.PipelineElements[0].Expression
        if ($value -isnot [Management.Automation.Language.StringConstantExpressionAst] -or
            $value.StringConstantType -ne 'SingleQuoted' -or $value.Value -cnotmatch '^[0-9a-f]{64}$') { throw 'source-structure-invalid' }
        [void]$maskedOffsets.Add($value.Extent.StartOffset)
    }
    $tokens = $null; $errors = $null
    [void][Management.Automation.Language.Parser]::ParseInput($Ast.Extent.Text, [ref]$tokens, [ref]$errors)
    if ($errors.Count -ne 0) { throw 'source-structure-invalid' }
    $orderedDefinitions = @($definitions | Sort-Object { $_.Extent.StartOffset })
    $activeDefinitions = [Collections.Generic.List[Management.Automation.Language.FunctionDefinitionAst]]::new()
    $definitionIndex = 0
    foreach ($token in $tokens) {
        # Keep comments too: #requires directives carry host semantics despite Comment tokens.
        if ($token.Kind -ceq 'EndOfInput') { continue }
        while ($activeDefinitions.Count -gt 0 -and $activeDefinitions[$activeDefinitions.Count-1].Extent.EndOffset -lt $token.Extent.EndOffset) {
            $activeDefinitions.RemoveAt($activeDefinitions.Count-1)
        }
        while ($definitionIndex -lt $orderedDefinitions.Count -and $orderedDefinitions[$definitionIndex].Extent.StartOffset -le $token.Extent.StartOffset) {
            $definition = $orderedDefinitions[$definitionIndex]
            while ($activeDefinitions.Count -gt 0 -and $activeDefinitions[$activeDefinitions.Count-1].Extent.EndOffset -lt $definition.Extent.EndOffset) {
                $activeDefinitions.RemoveAt($activeDefinitions.Count-1)
            }
            if ($definition.Extent.EndOffset -ge $token.Extent.EndOffset) { [void]$activeDefinitions.Add($definition) }
            $definitionIndex++
        }
        $scope = if ($activeDefinitions.Count -eq 0) { '<top>' } else { $activeDefinitions[$activeDefinitions.Count-1].Name }
        $text = if ($maskedOffsets.Contains($token.Extent.StartOffset)) { '<reviewed-policy-sha256>' } else { $token.Text.Replace("`r`n", "`n") }
        $semanticToken = [string]$token.Kind + ':' + $text.Length + ':' + $text
        # Whole-stream ordering also binds function placement and nesting across scopes.
        [void]$inventory['<top>'].Add($semanticToken)
        if ($scope -cne '<top>') { [void]$inventory[$scope].Add($semanticToken) }
    }
    $result = [ordered]@{}
    foreach ($scope in $inventory.Keys) {
        $bytes = [Text.UTF8Encoding]::new($false, $true).GetBytes(($inventory[$scope] -join "`n"))
        $result[$scope] = Get-IntentArcPreflightExecutionSha256 -Bytes $bytes
    }
    return $result
}

function Test-IntentArcPreflightEnvelopeSourcePolicy {
    param([Parameter(Mandatory)][AllowEmptyString()][string] $SourceText)
    $categories = [Collections.Generic.List[string]]::new()
    try {
        if (-not $script:IntentArcPreflightEnvelopeWasDotSourced -or $args.Count -ne 0) { throw 'source-structure-invalid' }
        $tokens = $null; $errors = $null
        $ast = [Management.Automation.Language.Parser]::ParseInput($SourceText, [ref]$tokens, [ref]$errors)
        if ($errors.Count -ne 0) { throw 'source-structure-invalid' }
        # Reviewed AST call sites include receiver, arguments, order, cardinality and enclosing control flow.
        # A new call requires review even when its method name is already admitted in another scope.
        $approved = @{
            'Invoke-IntentArcPreflightControllerLaunch' = '888dcbea898ad4b02724dfd624d4e16ee253662b826268767c48a6bdbd926735'
            '<top>' = '8a58e2a1abace2de5ea3269a782ab4a0745fb2e448c7a7d718a8d28e22c92176'
            'Throw-IntentArcPreflightExecutionAuthorizationInvalid' = 'ca838d59ee5bb8aa7e56c979c207720ee6ea8d93ff0a34953ce419fa5d49ef50'
            'Initialize-IntentArcPreflightExecutionNative' = '95d75948cf907a301b53683aa7c29187bca49e0ca712ad598a5f8cf41b0496c4'
            'Get-IntentArcPreflightExecutionSha256' = 'a28db6e42c9576c6705df817e1b58ac5d464b1147c330a21f81d0a58878882aa'
            'Test-IntentArcPreflightExecutionFixedTimeText' = 'd4a8d3555e7ab5fe6db3496b435ba761c102636bb8a85bcd86fc1f60382c49a6'
            'Test-IntentArcPreflightExecutionFixedText' = '119503e3ed2559f458274f69fe19fa0d3eac6c1282ad424b9853fe1fb93d0832'
            'Test-IntentArcPreflightExecutionFullyQualifiedWindowsPath' = 'f4a8d53811e3a0de837ee2650aac089b1d0c297323e415e21c2b761907806810'
            'Test-IntentArcPreflightExecutionExactPropertyNames' = '47f5f11ead082bf6fd811e52bcbcdaab0e283f42d7dd11620003d9428b8b76c3'
            'Test-IntentArcPreflightExecutionExactBindings' = 'b34132c0c22adf86e064a7bf387c4252d453020be46fb436d1daceb4528a6e7c'
            'New-IntentArcPreflightEnvelopeProductionContract' = '9278c530cc1e6a716ae51819e21c54cef3d127cf4f4198b2df5aad04ee7fb95a'
            'New-IntentArcPreflightEnvelopeTestContract' = '2de4e7993aa3e2f359d1c68e85e0da74ab01df5ae5a3fad6d95c978d4e01b61c'
            'Test-IntentArcPreflightEnvelopeContract' = '373bd9b4c10b2587b6af7544dc0baa7a77a7a709d82cb84f1a0b94dffbf7b5b4'
            'Test-IntentArcPreflightEnvelopeInternalContract' = 'ecab18e7773d8f26f99410e9b2ae284f7a8520c7c24676b0d20f1efa986ad9c7'
            'ConvertFrom-IntentArcPreflightExecutionWindowsCommandLine' = 'be2ea877bc0e690ebbfc0ae7de59361de9aca7cbce816505771c78c74c98b939'
            'Get-IntentArcPreflightExecutionProductionInvocationMetadata' = '3358e17f6840424702bd86137064277d34629bede0df24002d25d9c84dd4c2ce'
            'ConvertTo-IntentArcPreflightExecutionQuotedArgument' = 'a5a1928650a50bdf36054709c3d2fa3fa9c9466a88244eea613888874c76019f'
            'Set-IntentArcPreflightClosedProcessEnvironment' = '45325f37a6306f259e2b4e1dba2224fc6e3be095b7c1588f8aee0f68a3822d68'
            'New-IntentArcPreflightClosedProcessStartInfo' = 'aaa6948c6cce122976a45e78bf725f3ffd51f152cbdd4253cc2d754719af6941'
            'New-IntentArcPreflightControllerStartInfo' = 'a0979235df8568704f6226af45720462b30931f591618d42f8a6693b378aeec9'
            'New-IntentArcPreflightControllerLaunchBindings' = '82effc151f2d3cb25d242af136e66c05fac650d7ef1aa37f8996002b6613509f'
            'New-IntentArcPreflightGitObservationStartInfo' = '6f41b6c9ed4a1ee287f375b2461a362b2ca1882f0da20ae0def9c2ce04a61c9d'
            'New-IntentArcPreflightGitObservationBindings' = '0b06c05fe026fff04886e2038d7310b1cb9a55086ed0cca849c86702fc864065'
            'New-IntentArcPreflightControllerLaunchGate' = '15ae7bb32d30cfe0df958e41844b08c5b330b705dbd11584e31e835f24fe62ee'
            'Receive-IntentArcPreflightControllerOutput' = '0f885e57005a28dc28bc30b15288ee5daf79c9af2d2f8410bab76175a4a3f3c3'
            'Invoke-IntentArcPreflightGitObservation' = '13daf979318adbf775d901ba186261501d305b7dbdfb551815a34dc13d3ce974'
            'Write-IntentArcPreflightCapturedControllerOutput' = 'b2b0eee63b1ab551e398974c992e5a516e48ba0e556d9152619a8a1108f1c3c1'
            'Write-IntentArcPreflightEnvelopeAttemptReceipt' = '54d44db1bd77e730ed941ac4b51a4c56f62ff3757ef45922121ae72f90e7446d'
            'Finalize-IntentArcPreflightControllerAttempt' = 'bdb64999159aa55325e904405a241f6ef4366092ade904133939cb250d9fd1b5'
            'Test-IntentArcPreflightAttemptReceiptInteger' = '8b481d678885be39bad3d05c9dec919fb97f19d3dd776a16ab3a6c7f33a21e30'
            'Test-IntentArcPreflightAttemptReceiptNullableTimestamp' = 'd94943f15280bf895104e7a8d8d3695be1a361d9ef7e30805a7a9eb05c3d20a1'
            'Test-IntentArcPreflightAttemptReceiptNullableInteger' = '722354488a42d11a5e1c1ecb7b41bd24f878057bf52452cc13a1bf7f91577bbf'
            'Test-IntentArcPreflightAttemptReceipt' = '67fc2dba21919fd3f21553023d5f19d3e581f4bbbc1f49684e8f12b59bf427c6'
            'Test-IntentArcPreflightClosedInteger' = 'a117720b951149224c25551ae40c62c96a85713dcde0df684267baf0eef22992'
            'Test-IntentArcId06Timestamp' = '376334e92702f6f683002243e26642f0c48efec5220bbe6b6fd8d50b7a63ce57'
            'Test-IntentArcPreflightConsumption' = 'af5e4d7b22fac084d99d87f71cee673bb0f66238a1b484b50d00e73507e94fba'
            'Test-IntentArcPreflightControllerStarted' = 'ad525c37a13963a539a2c521076883be2f387d7509ee7884567474fef2f3616e'
            'Test-IntentArcId06ResultV2' = '5bc072f367283dad43f703fce9cf1865482aeb384be1e3fed89233e7165f9406'
            'Test-IntentArcId06ReceiptIdentity' = 'c7596b57acca174079445b608a14fe70b3e01328332a7966e22aaedcafde7770'
            'Test-IntentArcId06Receipt' = 'df618fb90f91a5d50d9cfe7f1b4b532c8269f9c56b7a0abb5bd2ac1094794f07'
            'Test-IntentArcId06OwnedRoot' = '45ee9bd4444b8d7511473b6f6f320e5abb1673df90c19ffa8cd18bbd426612d4'
            'Test-IntentArcId06Recovery' = 'f394f8d4ea49b165059988e23464c72751a01141110e4346666b80354dee8481'
            'Test-IntentArcId06Child' = '0e8146567dc9dffb60d34fdc73d276918d27bfaa5f8b38dd64231eb511bbbb29'
            'Test-IntentArcId06Cleanup' = '90a574c48b3699c63756af016d031e01969f30f18ebf8a709aa3d9c70cac9c4d'
            'Test-IntentArcId06Timestamps' = '4da3bafbd1b3ac7a1cacda287765a599726e0e4486f18a225065bac1fdddf808'
            'Test-IntentArcId06StateV2' = 'e0d2ef84272761f9dafc1f313809efe671ca3986a9eac155b8ed0ca730c9f0b2'
            'Test-IntentArcId06CandidateSuccess' = 'ec3b41c009a14d45ec95116603758c36a8ec177b8a2843ca2c684d6efe222dca'
            'Test-IntentArcPreflightAuditResult' = 'd12fed4b3a734bf92d670006d27baafa5c613dfc544f5dca4774a5e68184400b'
            'Read-IntentArcClosedJsonDocument' = 'f97653a55da8c07e51ab7d700b7bd9aa5002c498dcaa81da9b70ea671ff50db9'
            'Get-IntentArcPreflightExecutionExpectedBinding' = 'd15e3884615a11fdf9dbdf2c38044b16c6ecf4d99452bc8753e9858a765a2e13'
            'Test-IntentArcPreflightExecutionOuterHostBinding' = '71a690486615289fe3ec1ecd8412aaa37b15ce16c8e06f028f2280434e9735ab'
            'Test-IntentArcPreflightOnceInvocation' = 'd44f2383a3b70b57b1dc9e03392a112fbf7d350915b72d65a9829fc61d8b6196'
            'Get-IntentArcPreflightExecutionPinnedFaults' = '1aa74befe4675b119909bd8b3aaa0b173e581bac5f0dc55ce458c3d0dc46b7ed'
            'Open-IntentArcPreflightExecutionPinnedManifestFile' = '54a412d069b136bd347f0bfcab45fb045682ae3f19e0cc545d9e88fe5a85dd8c'
            'Assert-IntentArcPreflightExecutionJsonHasNoDuplicateKeys' = '2c4d7129b08830e8631201e1967366595232149ba71adade612b6eae194d8644'
            'Skip-IntentArcPreflightExecutionJsonWhitespace' = 'fffaf6ba895e41ab39dacd0536cef00d92b23990b5d1795ca7545fce0000c8c9'
            'Read-IntentArcPreflightExecutionJsonString' = '51b1df93685adf892c047330d510d379515f3fd9cb7d5b2ac6492da5d290020d'
            'Read-IntentArcPreflightExecutionJsonValue' = '3b3f699094b5486f944faa99ca0c8141773c3b01c1670616f9ffda7dd26e54f6'
            'Get-IntentArcPreflightExecutionDocumentValue' = '0e932a5cc3d2c7521e267d8d3c46fbc3de58ba4b6638fe692d998881a53cf74c'
            'Assert-IntentArcPreflightExecutionExactKeys' = '259cf75bd8aa68f8dfff57ae50fbf5b34e9f217e43ff1c5afc7dbf84c81f4a02'
            'Assert-IntentArcPreflightExecutionManifestTypes' = 'bad62990a7810731308a80d79736b326bd2dc6db71123162dadf5d086a89d15f'
            'Test-IntentArcPreflightExecutionCanonicalTimestamp' = '991a64530ce2e9ed82733bc873191e0e68ed03d1b91773e6f02948c1b4b12753'
            'Get-IntentArcPreflightExecutionPinnedFileSha256' = '34c4d1d3de88d71d352394248a45531049da14e85e2c43d4626c2aecbbf41be0'
            'Read-IntentArcPreflightExecutionAuthorizationManifest' = 'b2d47faf0a6e8056de98932542ae70a89c3f95c3a5e59a38785ad09e70b8a1a3'
            'Get-IntentArcPreflightEnvelopeOperationNames' = '388d3c041ecf8a32b436ed184ac2ceab5209c087efa94ba03bda0a740538063a'
            'Test-IntentArcPreflightEnvelopeOrderedPropertyNames' = '2d76ef7b3a45425f5dc9a627b4417cab4df02cf5a25d9d1e74147bbd271a793c'
            'New-IntentArcPreflightEnvelopeOperationDescriptor' = 'ab624b63a9a279997a4820d674a3db4c8e50f244ab54a618e8c85029b97824e6'
            'New-IntentArcPreflightEnvelopeOperations' = 'cd965d48c8c813db1e25f8ee33b89a1ce298b5fb45ad55f301f49aa63eef6722'
            'New-IntentArcPreflightEnvelopeOperationMap' = 'b95c5a08e02a2cbd14907f96f4105152e1318e8a98bdb1cbbf869820836b458e'
            'Assert-IntentArcPreflightEnvelopeOperations' = '7cf38ca5d64d51ff85db08d6af3116e5aaafaf687e15aecdac6355ac616a230e'
            'Assert-IntentArcPreflightEnvelopeAuthorizationContext' = 'dd4a5e71ad676835ce844c0c5457e18c969ba4ff77862aaec91fdda5e0a357a2'
            'Test-IntentArcPreflightEnvelopeFixedBytes' = '54f2a6664737c7527c94ba265d0489995dba6e8181545a60d6c0351a93d61a36'
            'Read-IntentArcPreflightEnvelopeRetainedManifestBytes' = '0d1b6f5edd2bc6116d33dd3d1d8d67c85e0f4de883f60be9af494b541bd5bd96'
            'New-IntentArcPreflightEnvelopeAttemptRoot' = '0f937a7f02e3e5be1c51a9cae43f9d400b81340bf5de57dc2259ee515bed5905'
            'Write-IntentArcPreflightEnvelopeImmutableBytes' = '33bacfbef66794856d97b47b792b1d16ed90e421b49c4104e0bcb53de7fe8fcb'
            'Copy-IntentArcPreflightEnvelopeAuthorization' = '76e063d6f7866a326e9fbd7dc0134abe038e91e716d24ded6386920b2651ce1e'
            'ConvertTo-IntentArcPreflightEnvelopeCanonicalBytes' = '985d078281b230284e7a568bd6c14820cb253623e7c1a85bcfc66d6ef63839f9'
            'Write-IntentArcPreflightEnvelopeConsumptionAttempted' = 'dc093363c01532152f38158d83a055f81aa32c913ee4cdcbb07de7980a75cc49'
            'Write-IntentArcPreflightEnvelopeControllerStarted' = 'f3dabe531ae42665cf07de8de1c61418c2d59e5ea02d78e2fa73818e3fb24e7a'
            'Get-IntentArcPreflightEnvelopeSingleOperationResult' = '2d7b0098b94d6a59ee34ecfd268309fac6c9a65ebf5b5f5d5e4598c5328681fd'
            'Assert-IntentArcPreflightEnvelopeBooleanRecord' = 'c24a50bc9a4f842bdaf79ce8aefba2c9155ea44242a28013d192b4c1a619e631'
            'Assert-IntentArcPreflightEnvelopeShaRecord' = '6d6a729989d9e8ba6783bd4d6a5e171190364c7eff194258acceaa60465b9a25'
            'Assert-IntentArcPreflightEnvelopeLaunchRecord' = '99acfa4c065aa254cace701a108fe0517bd46eba207feae07bf18b665b6c522a'
            'Invoke-IntentArcPreflightEnvelopeExecute' = '38b0da7621673000826952839fb86360bc3abe4dbe9ef6b16e90479cbdbb6eb6'
            'Get-IntentArcPreflightAuditProbeDisposition' = 'c726afd3e2efb005a76af36ccd5eaeb16e91efb9aafd3867a205d461f457ad86'
            'New-IntentArcPreflightTerminalAuditEvidence' = 'a0b6583c4ee3af019983d470c823dc2523d391365a81aacbc0d3a5adb3dbd4b8'
            'Read-IntentArcPreflightTerminalAuditProtectedDocument' = '4356a591f4adda72943dd4ce3bb9cc8b3a5fca365a36ed00fa7502d8c9e93525'
            'Read-IntentArcPreflightTerminalAuditProductionEvidence' = '64be18409918ad034f7699b20f912a7789b0c37f9d83a7525ec2bec80e86ac32'
            'New-IntentArcPreflightTerminalAuditProductionOperations' = '028fb74f265c9fe52fcdab4b82603bc4fc327ccae172b5b18088dafda2e2f427'
            'New-IntentArcPreflightTerminalAuditOperations' = '2d6a029dfb93ace6ea39dd5bc90dc271a9a174bd372ccbf3cfb2155e2b8b650f'
            'New-IntentArcPreflightTerminalAuditOperationMap' = 'cc19f6099a9dde85bf2fc676f0f5337c1af236fa99e02da32b417c79baaab75d'
            'Assert-IntentArcPreflightTerminalAuditOperations' = '3863e36697716c5d71ccecbad56bde5011fd277f63bbb41bf570ab3d42155d0d'
            'Test-IntentArcPreflightTerminalAuditEvidence' = '0fbdcfd80fa2a57ed6588b0e996b1716f6e6212e90644d5c4b9dce6b1f52bc01'
            'Test-IntentArcPreflightTerminalAuditGitResult' = 'f28eb00fd8fa6f55679f7fe03ad387d4818fb593102a7ffaf6da1ba61a354875'
            'New-IntentArcPreflightTerminalAuditProjection' = '714b3a2214cc190ece134f78a3454eec3d9ffa0eec8792a0cc135b893358ce7b'
            'Get-IntentArcPreflightTerminalAuditCategory' = 'f01dcfcf7147af4c291a1d1670b04287c80d1c4b53ac7731f66ac1e0014c4e76'
            'Invoke-IntentArcPreflightTerminalAudit' = '4bff7135cc257e693b47053c018f59bf0fbe3ae81d7fb7ff3231c0ed91efe095'
            'Invoke-IntentArcPreflightEnvelopeAuditOnly' = '69251ed8bc2967b28a5991c63271e5bfd3700f80838409eef1c7c5637c7e3c05'
            'New-IntentArcPreflightEnvelopeProductionOperations' = '7f3a6145f71b23fe9a3faa2c1fe36cc01777f833c5e5aed21ff1b71da8e3cf63'
            'Invoke-IntentArcPreflightEnvelopeHost' = 'ef8a593dd65f0983a7ffd8143e06717d9d2e6b9467c69e0ca42b04fc3d0412d4'
            'Get-IntentArcPreflightEnvelopeSourceCallInventory' = 'c735f30fd40a867113ec443a62e8ba2f096c7332a649968a511b6ded56fbb007'
            'Test-IntentArcPreflightEnvelopeSourcePolicy' = '0394069a4066011428a3c9bf7d48d4f14a260c0df5ba1d02ce1d808393515932'
            'Invoke-IntentArcPreflightEnvelopeStaticSelfTest' = 'eab36c0699370f59a6b0941fc94d10c8f869f9233cb84743b9e44282617f9c1f'
            'New-IntentArcPreflightExecutionAuthorizationRefusal' = 'e1f9a90791f0f5294ee5e59a323ffbb91c9b72758055737b759905e1959f4e5f'
        }
        $actual = Get-IntentArcPreflightEnvelopeSourceCallInventory -Ast $ast
        if ($actual.Count -ne $approved.Count) { [void]$categories.Add('source-structure-invalid') }
        foreach ($scope in $actual.Keys) {
            if (-not $approved.ContainsKey($scope) -or $approved[$scope] -cne $actual[$scope]) { [void]$categories.Add('source-call-invalid'); break }
        }
        $native = @($ast.FindAll({param($node) $node -is [Management.Automation.Language.StringConstantExpressionAst] -and $node.StringConstantType -eq 'SingleQuotedHereString'}, $true))
        if ($native.Count -ne 1 -or (Get-IntentArcPreflightExecutionSha256 -Bytes ([Text.UTF8Encoding]::new($false,$true).GetBytes($native[0].Value.Replace("`r`n","`n")))) -cne 'd56a2045c77fefa8a33cd790ee0374e1b797d6b38aa9192d14831f7a58740670') {
            [void]$categories.Add('native-dispatcher-invalid')
        }
        # Reject both direct and concatenated identifiers outside the two fixed run namespaces.
        $folded = $SourceText -replace "['\" + '"' + "\s+]", ''
        foreach ($match in [regex]::Matches($folded, 'phase1-preflight-[0-9]{8}-[0-9]{2}')) {
            if ($match.Value -cne $script:IntentArcPreflightExecutionControllerRunId) { [void]$categories.Add('source-structure-invalid'); break }
        }
    } catch { [void]$categories.Add('source-structure-invalid') }
    return [pscustomobject][ordered]@{ valid = $categories.Count -eq 0; categories = @($categories | Select-Object -Unique) }
}

function Invoke-IntentArcPreflightEnvelopeStaticSelfTest {
    param()
    if (-not $script:IntentArcPreflightEnvelopeWasDotSourced -or $args.Count -ne 0) { throw 'source-structure-invalid' }
    $root = $MyInvocation.MyCommand.ScriptBlock.Ast
    while ($null -ne $root.Parent) { $root = $root.Parent }
    return Test-IntentArcPreflightEnvelopeSourcePolicy -SourceText $root.Extent.Text
}

function New-IntentArcPreflightExecutionAuthorizationRefusal {
    return [ordered]@{
        schema = 'intentarc.preflight-execution-audit/v1'; status = 'TERMINAL-NOT-PASS'; category = 'authorization-invalid'
        attemptId = $script:IntentArcPreflightExecutionAttemptId; controllerRunId = $script:IntentArcPreflightExecutionControllerRunId
        expectedCommit = $null; attemptConsumed = $false; controllerStarted = $false; controllerExitCode = $null
        resultSha256 = $null; stateSha256 = $null; receiptSha256 = $null; outRestored = $false
        cleanupComplete = $false; gitClean = $false; bindingsValid = $false
    }
}

if (-not $script:IntentArcPreflightEnvelopeWasDotSourced) {
    $closedJson = $script:IntentArcPreflightExecutionRefusalJson
    try {
        $productionContract = New-IntentArcPreflightEnvelopeProductionContract
        if (-not (Test-IntentArcPreflightEnvelopeContract $productionContract)) { Throw-IntentArcPreflightExecutionAuthorizationInvalid }
        $metadata = Get-IntentArcPreflightExecutionProductionInvocationMetadata
        $invocation = Test-IntentArcPreflightOnceInvocation -RawArguments $script:IntentArcPreflightEnvelopeProductionArguments -InvocationMetadata $metadata
        if ($null -eq $invocation -or -not (Test-IntentArcPreflightExecutionOuterHostBinding -Invocation $invocation -Contract $productionContract)) {
            Throw-IntentArcPreflightExecutionAuthorizationInvalid
        }
        $result = Invoke-IntentArcPreflightEnvelopeHost -Invocation $invocation
        $candidateJson = $result | ConvertTo-Json -Compress -Depth 8 -ErrorAction Stop
        $closedDocument = $candidateJson | ConvertFrom-Json -ErrorAction Stop
        if (-not (Test-IntentArcPreflightAuditResult -Document $closedDocument)) { throw 'audit-invalid' }
        $closedJson = $candidateJson
    } catch {
        $closedJson = $script:IntentArcPreflightExecutionRefusalJson
    } finally {
        try { [Console]::Out.WriteLine($closedJson) } catch {}
    }
    if ($closedJson -cne $script:IntentArcPreflightExecutionRefusalJson -and $closedDocument.status -ceq 'AUDITED-PASS') { exit 0 }
    exit 1
}
