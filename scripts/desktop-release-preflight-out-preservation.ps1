function New-IntentArcPreflightOutPreservationProductionContract {
    $repositoryRoot = 'C:\projects\Project Manager'
    $runId = 'phase1-preflight-20260901-06'
    $preservationParent = Join-Path $repositoryRoot '.superpowers\preflight-out-preservation'
    $runRoot = Join-Path $preservationParent $runId
    return [ordered]@{
        repositoryRoot = $repositoryRoot
        superpowersPath = Join-Path $repositoryRoot '.superpowers'
        preservationParent = $preservationParent
        runRoot = $runRoot
        childProfilePath = Join-Path $runRoot 'profile'
        childLocalAppDataPath = Join-Path $runRoot 'localappdata'
        childRoamingAppDataPath = Join-Path $runRoot 'localappdata\Roaming'
        sourcePath = Join-Path $repositoryRoot 'out'
        destinationPath = Join-Path $runRoot 'out'
        statePath = Join-Path $preservationParent ($runId + '.json')
        receiptPath = Join-Path $repositoryRoot ('.superpowers\preflight\desktop-release\' + $runId + '.json')
        branch = 'master'
        jobName = 'IntentArc.Preflight.phase1-preflight-20260901-06'
        gitExecutable = 'C:\Program Files\Git\cmd\git.exe'
        gitDirectory = 'C:\Program Files\Git\cmd'
        gitSha256 = '54194a1af7cfb6730448ce14b8f2c1dddd9f950b7f995dc351c1ed16eb179249'
        nodeExecutable = 'C:\Program Files\nodejs\node.exe'
        nodeDirectory = 'C:\Program Files\nodejs'
        nodeSha256 = 'b7d912484d42e7a0d0cb5b26a86410ec973a79ece7d61ad535e2d1a97a9026e1'
        cmdExecutable = 'C:\Windows\System32\cmd.exe'
        cmdDirectory = 'C:\Windows\System32'
        cmdSha256 = '8dd1ebb0b969370c70a5ee7f7ee347949aa7046aa5e1a33fcd7b1e9415b21fc3'
        runId = $runId
        maximumBytesPerStream = 1048576
        timeoutMilliseconds = 2700000
    }
}

function Initialize-IntentArcPreflightNativeProcessType {
    if ($null -ne ('IntentArc.Preflight.NativeProcess' -as [type])) { return }
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

namespace IntentArc.Preflight {
    public static class StateFileSecurity {
        const int MOVEFILE_REPLACE_EXISTING = 0x1;
        const int MOVEFILE_WRITE_THROUGH = 0x8;
        static readonly SecurityIdentifier SystemSid = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
        static readonly SecurityIdentifier AdministratorsSid = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool MoveFileExW(string existingFileName, string newFileName, int flags);

        static SecurityIdentifier CurrentSid() {
            using (WindowsIdentity identity = WindowsIdentity.GetCurrent()) {
                if (identity.User == null) throw new InvalidOperationException();
                return identity.User;
            }
        }

        static void AddAllowedRules(FileSystemSecurity security, bool directory) {
            SecurityIdentifier current = CurrentSid();
            security.SetOwner(current);
            security.SetAccessRuleProtection(true, false);
            InheritanceFlags inheritance = directory
                ? InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit
                : InheritanceFlags.None;
            foreach (SecurityIdentifier sid in new[] { current, SystemSid, AdministratorsSid }) {
                security.AddAccessRule(new FileSystemAccessRule(
                    sid, FileSystemRights.FullControl, inheritance,
                    PropagationFlags.None, AccessControlType.Allow));
            }
        }

        internal static byte[] ClosedDirectorySecurityDescriptor() {
            var security = new DirectorySecurity();
            AddAllowedRules(security, true);
            return security.GetSecurityDescriptorBinaryForm();
        }

        public static void ProtectParent(string parentPath) {
            string fullPath = Path.GetFullPath(parentPath);
            FileAttributes attributes = 0;
            bool exists = false;
            try {
                attributes = File.GetAttributes(fullPath);
                exists = true;
            } catch (FileNotFoundException) {
            } catch (DirectoryNotFoundException) {
            }
            if (exists) {
                if ((attributes & FileAttributes.Directory) == 0 ||
                    (attributes & FileAttributes.ReparsePoint) != 0) throw new InvalidOperationException();
                var existing = new DirectoryInfo(fullPath);
                if (IsClosed(existing.GetAccessControl(AccessControlSections.Owner | AccessControlSections.Access))) return;
                existing.Delete(false);
            }
            try {
                File.GetAttributes(fullPath);
                throw new InvalidOperationException();
            } catch (FileNotFoundException) {
            } catch (DirectoryNotFoundException) {
            }
            var security = new DirectorySecurity();
            AddAllowedRules(security, true);
            Directory.CreateDirectory(fullPath, security);
            attributes = File.GetAttributes(fullPath);
            if ((attributes & FileAttributes.Directory) == 0 ||
                (attributes & FileAttributes.ReparsePoint) != 0 ||
                !IsClosed(new DirectoryInfo(fullPath).GetAccessControl(AccessControlSections.Owner | AccessControlSections.Access))) {
                throw new InvalidOperationException();
            }
        }

        public static void ProtectFile(string statePath) {
            var security = new FileSecurity();
            AddAllowedRules(security, false);
            new FileInfo(Path.GetFullPath(statePath)).SetAccessControl(security);
        }

        static bool IsClosed(FileSystemSecurity security) {
            SecurityIdentifier current = CurrentSid();
            if (!security.AreAccessRulesProtected || !current.Equals(security.GetOwner(typeof(SecurityIdentifier)))) return false;
            InheritanceFlags expectedInheritance = security is DirectorySecurity
                ? InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit
                : InheritanceFlags.None;
            var expected = new HashSet<string>(StringComparer.Ordinal) {
                current.Value, SystemSid.Value, AdministratorsSid.Value
            };
            AuthorizationRuleCollection rules = security.GetAccessRules(true, true, typeof(SecurityIdentifier));
            if (rules.Count != expected.Count) return false;
            foreach (FileSystemAccessRule rule in rules) {
                var sid = (SecurityIdentifier)rule.IdentityReference;
                if (rule.IsInherited || rule.AccessControlType != AccessControlType.Allow ||
                    rule.FileSystemRights != FileSystemRights.FullControl ||
                    rule.InheritanceFlags != expectedInheritance ||
                    rule.PropagationFlags != PropagationFlags.None ||
                    !expected.Remove(sid.Value)) return false;
            }
            return expected.Count == 0;
        }

        public static void PromoteStateFile(string temporaryPath, string statePath) {
            string temporary = Path.GetFullPath(temporaryPath);
            string destination = Path.GetFullPath(statePath);
            if (!string.Equals(Path.GetDirectoryName(temporary), Path.GetDirectoryName(destination), StringComparison.OrdinalIgnoreCase)) {
                throw new InvalidOperationException();
            }
            if (!MoveFileExW(temporary, destination, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
        }

        public static bool Validate(string statePath, string parentPath) {
            try {
                return ValidateParent(parentPath) &&
                    IsClosed(new FileInfo(Path.GetFullPath(statePath)).GetAccessControl(AccessControlSections.Owner | AccessControlSections.Access));
            } catch { return false; }
        }

        public static bool ValidateParent(string parentPath) {
            try {
                string fullPath = Path.GetFullPath(parentPath);
                FileAttributes attributes = File.GetAttributes(fullPath);
                return (attributes & FileAttributes.Directory) != 0 &&
                    (attributes & FileAttributes.ReparsePoint) == 0 &&
                    IsClosed(new DirectoryInfo(fullPath).GetAccessControl(AccessControlSections.Owner | AccessControlSections.Access));
            } catch { return false; }
        }

        internal static bool ValidateParentIdentity(string parentPath, string expectedIdentity) {
            try {
                return !String.IsNullOrEmpty(expectedIdentity) && ValidateParent(parentPath) &&
                    String.Equals(DirectoryRenameSession.ReadPathIdentity(Path.GetFullPath(parentPath)),
                        expectedIdentity, StringComparison.Ordinal);
            } catch { return false; }
        }
    }

    public sealed class NativeProcessResult {
        public bool StartAttempted { get; set; }
        public bool Started { get; set; }
        public int? ExitCode { get; set; }
        public bool Canceled { get; set; }
        public bool TimedOut { get; set; }
        public bool OutputOverflow { get; set; }
        public bool DescendantsSettled { get; set; }
        public bool InfrastructureFailure { get; set; }
        public long StandardOutputBytes { get; set; }
        public long StandardErrorBytes { get; set; }
        public string JobName { get; set; }
        public int? RootProcessId { get; set; }
        public string RootStartTimeUtc { get; set; }
        public bool AssignmentSucceeded { get; set; }
    }

    public static class NativeProcess {
        const uint CREATE_SUSPENDED = 0x00000004;
        const uint CREATE_NO_WINDOW = 0x08000000;
        const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
        const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
        const uint STARTF_USESTDHANDLES = 0x00000100;
        const uint HANDLE_FLAG_INHERIT = 0x00000001;
        const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
        const uint WAIT_OBJECT_0 = 0;
        const uint WAIT_TIMEOUT = 258;
        const uint INFINITE = 0xffffffff;
        const int JobObjectBasicAccountingInformation = 1;
        const int JobObjectExtendedLimitInformation = 9;
        const uint JOB_OBJECT_QUERY = 0x0004;
        const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
        const uint STILL_ACTIVE = 259;
        const uint GENERIC_READ = 0x80000000;
        const uint FILE_SHARE_READ = 0x00000001;
        const uint FILE_SHARE_WRITE = 0x00000002;
        const uint OPEN_EXISTING = 3;
        static readonly IntPtr PROC_THREAD_ATTRIBUTE_HANDLE_LIST = new IntPtr(0x00020002);
        static readonly IntPtr PROC_THREAD_ATTRIBUTE_JOB_LIST = new IntPtr(0x0002000d);

        [StructLayout(LayoutKind.Sequential)]
        struct SECURITY_ATTRIBUTES {
            public int nLength;
            public IntPtr lpSecurityDescriptor;
            [MarshalAs(UnmanagedType.Bool)] public bool bInheritHandle;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct STARTUPINFO {
            public int cb;
            public string lpReserved;
            public string lpDesktop;
            public string lpTitle;
            public uint dwX;
            public uint dwY;
            public uint dwXSize;
            public uint dwYSize;
            public uint dwXCountChars;
            public uint dwYCountChars;
            public uint dwFillAttribute;
            public uint dwFlags;
            public short wShowWindow;
            public short cbReserved2;
            public IntPtr lpReserved2;
            public IntPtr hStdInput;
            public IntPtr hStdOutput;
            public IntPtr hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct STARTUPINFOEX {
            public STARTUPINFO StartupInfo;
            public IntPtr lpAttributeList;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct PROCESS_INFORMATION {
            public IntPtr hProcess;
            public IntPtr hThread;
            public uint dwProcessId;
            public uint dwThreadId;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct IO_COUNTERS {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION {
            public long TotalUserTime;
            public long TotalKernelTime;
            public long ThisPeriodTotalUserTime;
            public long ThisPeriodTotalKernelTime;
            public uint TotalPageFaultCount;
            public uint TotalProcesses;
            public uint ActiveProcesses;
            public uint TotalTerminatedProcesses;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool CreateProcessW(string applicationName, StringBuilder commandLine, IntPtr processAttributes,
            IntPtr threadAttributes, bool inheritHandles, uint creationFlags, IntPtr environment,
            string currentDirectory, ref STARTUPINFOEX startupInfo, out PROCESS_INFORMATION processInformation);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern IntPtr CreateFileW(string name, uint access, uint share, ref SECURITY_ATTRIBUTES security,
            uint disposition, uint flags, IntPtr template);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool InitializeProcThreadAttributeList(IntPtr attributeList, int count, int flags, ref IntPtr size);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool UpdateProcThreadAttribute(IntPtr attributeList, uint flags, IntPtr attribute,
            IntPtr value, IntPtr size, IntPtr previousValue, IntPtr returnSize);
        [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr attributeList);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool CreatePipe(out IntPtr readPipe, out IntPtr writePipe, ref SECURITY_ATTRIBUTES attributes, uint size);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
        [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info, uint length, IntPtr returnLength);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint exitCode);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint exitCode);
        [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
        [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
        [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr process, out System.Runtime.InteropServices.ComTypes.FILETIME creation,
            out System.Runtime.InteropServices.ComTypes.FILETIME exit, out System.Runtime.InteropServices.ComTypes.FILETIME kernel,
            out System.Runtime.InteropServices.ComTypes.FILETIME user);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int stdHandle);

        static string Quote(string value) {
            if (value.Length != 0 && value.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return value;
            var result = new StringBuilder("\"");
            int slashes = 0;
            foreach (char c in value) {
                if (c == '\\') { slashes++; continue; }
                if (c == '"') { result.Append('\\', slashes * 2 + 1); result.Append('"'); slashes = 0; continue; }
                result.Append('\\', slashes); slashes = 0; result.Append(c);
            }
            result.Append('\\', slashes * 2); result.Append('"');
            return result.ToString();
        }

        static IntPtr BuildEnvironment(IDictionary<string, string> environment) {
            var keys = new List<string>(environment.Keys);
            keys.Sort(StringComparer.OrdinalIgnoreCase);
            var builder = new StringBuilder();
            foreach (string key in keys) builder.Append(key).Append('=').Append(environment[key]).Append('\0');
            builder.Append('\0');
            byte[] bytes = Encoding.Unicode.GetBytes(builder.ToString());
            IntPtr pointer = Marshal.AllocHGlobal(bytes.Length);
            Marshal.Copy(bytes, 0, pointer, bytes.Length);
            return pointer;
        }

        static Task Drain(IntPtr readHandle, Action<int> observe, MemoryStream capture, int maximumBytes) {
            return Task.Run(() => {
                using (var stream = new FileStream(new SafeFileHandle(readHandle, true), FileAccess.Read, 4096, false)) {
                    var buffer = new byte[4096];
                    int read;
                    while ((read = stream.Read(buffer, 0, buffer.Length)) > 0) {
                        observe(read);
                        int retained = Math.Min(read, Math.Max(0, maximumBytes - (int)capture.Length));
                        if (retained > 0) capture.Write(buffer, 0, retained);
                    }
                }
            });
        }

        static uint Active(IntPtr job) {
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info;
            if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, out info,
                (uint)Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)), IntPtr.Zero)) {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            return info.ActiveProcesses;
        }

        static bool WaitForZero(IntPtr job, int milliseconds) {
            long deadline = Stopwatch.GetTimestamp() + (long)(Math.Max(0, milliseconds) * (Stopwatch.Frequency / 1000.0));
            do {
                if (Active(job) == 0) return true;
                Thread.Sleep(10);
            } while (Stopwatch.GetTimestamp() < deadline);
            return Active(job) == 0;
        }

        static string ProcessStartTime(IntPtr process) {
            System.Runtime.InteropServices.ComTypes.FILETIME creation, exit, kernel, user;
            if (!GetProcessTimes(process, out creation, out exit, out kernel, out user))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            long value = ((long)creation.dwHighDateTime << 32) | (uint)creation.dwLowDateTime;
            return DateTime.FromFileTimeUtc(value).ToString("o");
        }

        public static bool ProveSettlement(string jobName, int rootProcessId, string rootStartTimeUtc) {
            IntPtr job = IntPtr.Zero, process = IntPtr.Zero;
            try {
                job = OpenJobObject(JOB_OBJECT_QUERY, false, jobName);
                if (job != IntPtr.Zero && Active(job) != 0) return false;
                if (job == IntPtr.Zero && Marshal.GetLastWin32Error() != 2) return false;
                if (rootProcessId <= 0 || String.IsNullOrEmpty(rootStartTimeUtc)) return true;
                process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, (uint)rootProcessId);
                if (process == IntPtr.Zero) return Marshal.GetLastWin32Error() == 87;
                if (!String.Equals(ProcessStartTime(process), rootStartTimeUtc, StringComparison.Ordinal)) return true;
                uint exitCode;
                return GetExitCodeProcess(process, out exitCode) && exitCode != STILL_ACTIVE;
            } catch { return false; }
            finally {
                if (process != IntPtr.Zero) CloseHandle(process);
                if (job != IntPtr.Zero) CloseHandle(job);
            }
        }

        public static NativeProcessResult Run(string executable, string[] arguments, string workingDirectory,
            IDictionary<string, string> environment, int timeoutMilliseconds, int descendantGraceMilliseconds,
            int maximumBytesPerStream, string jobName) {
            return RunInternal(executable, arguments, workingDirectory, environment, timeoutMilliseconds,
                descendantGraceMilliseconds, maximumBytesPerStream, jobName, 0, null);
        }

        public static string RunForStandardOutput(string executable, string[] arguments, string workingDirectory,
            IDictionary<string, string> environment, int timeoutMilliseconds, int descendantGraceMilliseconds,
            int maximumBytesPerStream, string jobName) {
            var standardOutput = new StringBuilder();
            NativeProcessResult result = RunInternal(executable, arguments, workingDirectory, environment, timeoutMilliseconds,
                descendantGraceMilliseconds, maximumBytesPerStream, jobName, 0, standardOutput);
            if (!result.Started || result.ExitCode != 0 || result.Canceled || result.TimedOut || result.OutputOverflow ||
                !result.DescendantsSettled || result.InfrastructureFailure || result.StandardErrorBytes != 0) {
                throw new InvalidOperationException();
            }
            return standardOutput.ToString();
        }

        public static NativeProcessResult RunForTest(string executable, string[] arguments, string workingDirectory,
            IDictionary<string, string> environment, int timeoutMilliseconds, int descendantGraceMilliseconds,
            int maximumBytesPerStream, string jobName, string faultName) {
            int fault = faultName == "assignment-failure" ? 1 :
                faultName == "pre-assignment-exception" ? 2 :
                faultName == "termination-failure" ? 3 :
                faultName == "root-wait-failure" ? 4 :
                faultName == "pre-create-cancellation" ? 5 :
                faultName == "post-create-cancellation" ? 6 :
                faultName == "pre-create-infrastructure-failure" ? 7 :
                faultName == "post-create-infrastructure-failure" ? 8 :
                faultName == "identity-capture-failure" ? 9 : 0;
            if (fault == 0) throw new ArgumentException("faultName");
            return RunInternal(executable, arguments, workingDirectory, environment, timeoutMilliseconds,
                descendantGraceMilliseconds, maximumBytesPerStream, jobName, fault, null);
        }

        static NativeProcessResult RunInternal(string executable, string[] arguments, string workingDirectory,
            IDictionary<string, string> environment, int timeoutMilliseconds, int descendantGraceMilliseconds,
            int maximumBytesPerStream, string jobName, int testFault, StringBuilder standardOutput) {
            var result = new NativeProcessResult { StartAttempted = true, DescendantsSettled = true, JobName = jobName };
            IntPtr job = IntPtr.Zero, outRead = IntPtr.Zero, outWrite = IntPtr.Zero,
                errRead = IntPtr.Zero, errWrite = IntPtr.Zero, nullInput = IntPtr.Zero,
                environmentBlock = IntPtr.Zero, attributeList = IntPtr.Zero, handleList = IntPtr.Zero,
                jobList = IntPtr.Zero;
            PROCESS_INFORMATION pi = new PROCESS_INFORMATION();
            Task outTask = null, errTask = null;
            bool created = false, assigned = false, attributeListInitialized = false;
            long stdoutBytes = 0, stderrBytes = 0;
            var stdoutCapture = new MemoryStream();
            var stderrCapture = new MemoryStream();
            try {
                var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                job = CreateJobObject(IntPtr.Zero, jobName);
                if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
                if (Marshal.GetLastWin32Error() == 183) throw new InvalidOperationException();
                int limitSize = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
                IntPtr limitPointer = Marshal.AllocHGlobal(limitSize);
                try {
                    Marshal.StructureToPtr(limits, limitPointer, false);
                    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, limitPointer, (uint)limitSize))
                        throw new Win32Exception(Marshal.GetLastWin32Error());
                } finally { Marshal.FreeHGlobal(limitPointer); }

                var security = new SECURITY_ATTRIBUTES { nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), bInheritHandle = true };
                if (!CreatePipe(out outRead, out outWrite, ref security, 0) || !SetHandleInformation(outRead, HANDLE_FLAG_INHERIT, 0) ||
                    !CreatePipe(out errRead, out errWrite, ref security, 0) || !SetHandleInformation(errRead, HANDLE_FLAG_INHERIT, 0))
                    throw new Win32Exception(Marshal.GetLastWin32Error());

                nullInput = CreateFileW("NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, ref security, OPEN_EXISTING, 0, IntPtr.Zero);
                if (nullInput == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
                var startup = new STARTUPINFOEX();
                startup.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
                startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
                startup.StartupInfo.hStdInput = nullInput;
                startup.StartupInfo.hStdOutput = outWrite;
                startup.StartupInfo.hStdError = errWrite;
                IntPtr attributeBytes = IntPtr.Zero;
                InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref attributeBytes);
                attributeList = Marshal.AllocHGlobal(attributeBytes);
                if (!InitializeProcThreadAttributeList(attributeList, 2, 0, ref attributeBytes))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                attributeListInitialized = true;
                startup.lpAttributeList = attributeList;
                handleList = Marshal.AllocHGlobal(IntPtr.Size * 3);
                Marshal.WriteIntPtr(handleList, 0, nullInput);
                Marshal.WriteIntPtr(handleList, IntPtr.Size, outWrite);
                Marshal.WriteIntPtr(handleList, IntPtr.Size * 2, errWrite);
                if (!UpdateProcThreadAttribute(attributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                    handleList, new IntPtr(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                if (testFault == 1) throw new Win32Exception(5);
                jobList = Marshal.AllocHGlobal(IntPtr.Size);
                Marshal.WriteIntPtr(jobList, job);
                if (!UpdateProcThreadAttribute(attributeList, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST,
                    jobList, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                if (testFault == 5) { result.Canceled = true; return result; }
                if (testFault == 2 || testFault == 7) throw new InvalidOperationException("injected-pre-create-fault");
                var command = new StringBuilder(Quote(executable));
                foreach (string argument in arguments) command.Append(' ').Append(Quote(argument));
                environmentBlock = BuildEnvironment(environment);
                created = CreateProcessW(executable, command, IntPtr.Zero, IntPtr.Zero, true,
                    CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
                    environmentBlock, workingDirectory, ref startup, out pi);
                if (!created) { result.InfrastructureFailure = true; return result; }
                result.Started = true;
                assigned = true;
                result.AssignmentSucceeded = true;
                int rootProcessId = (int)pi.dwProcessId;
                if (testFault == 9) throw new InvalidOperationException("injected-identity-capture-fault");
                string rootStartTimeUtc = ProcessStartTime(pi.hProcess);
                result.RootProcessId = rootProcessId;
                result.RootStartTimeUtc = rootStartTimeUtc;
                CloseHandle(outWrite); outWrite = IntPtr.Zero;
                CloseHandle(errWrite); errWrite = IntPtr.Zero;
                outTask = Drain(outRead, count => Interlocked.Add(ref stdoutBytes, count), stdoutCapture, maximumBytesPerStream); outRead = IntPtr.Zero;
                errTask = Drain(errRead, count => Interlocked.Add(ref stderrBytes, count), stderrCapture, maximumBytesPerStream); errRead = IntPtr.Zero;
                if (testFault == 6) { result.Canceled = true; throw new OperationCanceledException(); }
                if (testFault == 8) throw new InvalidOperationException("injected-post-create-fault");
                if (testFault == 3) throw new InvalidOperationException("injected-post-create-fault");
                if (ResumeThread(pi.hThread) == uint.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error());
                uint wait = WAIT_TIMEOUT;
                bool overflowTerminated = false;
                long processDeadline = Stopwatch.GetTimestamp() +
                    (long)(Math.Max(1, timeoutMilliseconds) * (Stopwatch.Frequency / 1000.0));
                while (Stopwatch.GetTimestamp() < processDeadline) {
                    if (Interlocked.Read(ref stdoutBytes) > maximumBytesPerStream ||
                        Interlocked.Read(ref stderrBytes) > maximumBytesPerStream) {
                        result.OutputOverflow = true;
                        overflowTerminated = true;
                        TerminateJobObject(job, 0xdead);
                        break;
                    }
                    wait = WaitForSingleObject(pi.hProcess, 25);
                    if (wait == WAIT_OBJECT_0) break;
                    if (wait != WAIT_TIMEOUT) throw new Win32Exception(Marshal.GetLastWin32Error());
                }
                if (overflowTerminated) {
                    wait = WaitForSingleObject(pi.hProcess, 5000);
                    if (wait != WAIT_OBJECT_0) result.InfrastructureFailure = true;
                } else if (wait == WAIT_TIMEOUT) {
                    result.TimedOut = true;
                    TerminateJobObject(job, 0xdead);
                } else if (wait != WAIT_OBJECT_0) {
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                } else {
                    uint exit;
                    if (!GetExitCodeProcess(pi.hProcess, out exit)) throw new Win32Exception(Marshal.GetLastWin32Error());
                    result.ExitCode = unchecked((int)exit);
                    if (!WaitForZero(job, descendantGraceMilliseconds)) TerminateJobObject(job, 0xdead);
                }
                bool rootStopped = !created || pi.hProcess == IntPtr.Zero || WaitForSingleObject(pi.hProcess, 5000) == WAIT_OBJECT_0;
                result.DescendantsSettled = rootStopped && WaitForZero(job, 5000);
                if (testFault == 4) result.DescendantsSettled = false;
                if (!result.DescendantsSettled) result.InfrastructureFailure = true;
                if (outTask != null && !outTask.Wait(5000)) result.InfrastructureFailure = true;
                if (errTask != null && !errTask.Wait(5000)) result.InfrastructureFailure = true;
            } catch {
                if (!result.Canceled) result.InfrastructureFailure = true;
                if (assigned) { try { TerminateJobObject(job, 0xdead); } catch { } }
                else if (created && pi.hProcess != IntPtr.Zero) { try { TerminateProcess(pi.hProcess, 0xdead); } catch { } }
                try {
                    bool rootStopped = !created || pi.hProcess == IntPtr.Zero || WaitForSingleObject(pi.hProcess, 5000) == WAIT_OBJECT_0;
                    result.DescendantsSettled = rootStopped && (job == IntPtr.Zero || WaitForZero(job, 5000));
                    if (testFault == 3) result.DescendantsSettled = false;
                } catch { result.DescendantsSettled = false; }
                try {
                    if (outTask != null && !outTask.Wait(5000)) result.InfrastructureFailure = true;
                    if (errTask != null && !errTask.Wait(5000)) result.InfrastructureFailure = true;
                } catch { result.InfrastructureFailure = true; }
            } finally {
                result.StandardOutputBytes = stdoutBytes;
                result.StandardErrorBytes = stderrBytes;
                if (standardOutput != null) standardOutput.Append(Encoding.UTF8.GetString(stdoutCapture.ToArray()));
                result.OutputOverflow = result.OutputOverflow || stdoutBytes > maximumBytesPerStream || stderrBytes > maximumBytesPerStream;
                if (result.OutputOverflow) result.ExitCode = null;
                if (result.DescendantsSettled) {
                    if (result.OutputOverflow) {
                        result.TimedOut = false;
                        result.Canceled = false;
                        result.InfrastructureFailure = false;
                    } else if (result.TimedOut) {
                        result.Canceled = false;
                        result.InfrastructureFailure = false;
                        result.ExitCode = null;
                    } else if (result.Canceled) {
                        result.InfrastructureFailure = false;
                        result.ExitCode = null;
                    }
                }
                if (environmentBlock != IntPtr.Zero) Marshal.FreeHGlobal(environmentBlock);
                if (attributeListInitialized) DeleteProcThreadAttributeList(attributeList);
                if (attributeList != IntPtr.Zero) Marshal.FreeHGlobal(attributeList);
                if (handleList != IntPtr.Zero) Marshal.FreeHGlobal(handleList);
                if (jobList != IntPtr.Zero) Marshal.FreeHGlobal(jobList);
                if (nullInput != IntPtr.Zero && nullInput != new IntPtr(-1)) CloseHandle(nullInput);
                if (outWrite != IntPtr.Zero) CloseHandle(outWrite);
                if (errWrite != IntPtr.Zero) CloseHandle(errWrite);
                if (outRead != IntPtr.Zero) CloseHandle(outRead);
                if (errRead != IntPtr.Zero) CloseHandle(errRead);
                if (pi.hThread != IntPtr.Zero) CloseHandle(pi.hThread);
                if (pi.hProcess != IntPtr.Zero) CloseHandle(pi.hProcess);
                if (job != IntPtr.Zero) CloseHandle(job);
            }
            return result;
        }
    }

    public sealed class DirectoryRenameSession : IDisposable {
        const uint DELETE = 0x00010000;
        const uint SYNCHRONIZE = 0x00100000;
        const uint FILE_READ_ATTRIBUTES = 0x00000080;
        const uint FILE_LIST_DIRECTORY = 0x00000001;
        const uint FILE_ADD_SUBDIRECTORY = 0x00000004;
        const uint FILE_SHARE_READ = 0x00000001;
        const uint FILE_SHARE_WRITE = 0x00000002;
        const uint FILE_OPEN = 0x00000001;
        const uint FILE_CREATE = 0x00000002;
        const uint FILE_OPEN_REPARSE_POINT = 0x00200000;
        const uint FILE_OPEN_FOR_BACKUP_INTENT = 0x00004000;
        const uint FILE_SYNCHRONOUS_IO_NONALERT = 0x00000020;
        const uint FILE_DIRECTORY_FILE = 0x00000001;
        const uint OBJ_CASE_INSENSITIVE = 0x00000040;
        const uint OPEN_EXISTING = 3;
        const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
        const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
        const uint FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
        const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
        const int FileRenameInformation = 10;
        const int FileDispositionInfo = 4;
        const int STATUS_OBJECT_NAME_COLLISION = unchecked((int)0xc0000035);
        static readonly IntPtr InvalidHandle = new IntPtr(-1);

        [StructLayout(LayoutKind.Sequential)]
        struct BY_HANDLE_FILE_INFORMATION {
            public uint FileAttributes;
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
        struct FILE_RENAME_HEADER {
            [MarshalAs(UnmanagedType.Bool)] public bool ReplaceIfExists;
            public IntPtr RootDirectory;
            public uint FileNameLength;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct IO_STATUS_BLOCK {
            public IntPtr Status;
            public UIntPtr Information;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct FILE_DISPOSITION_INFO {
            [MarshalAs(UnmanagedType.Bool)] public bool DeleteFile;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct UNICODE_STRING {
            public ushort Length;
            public ushort MaximumLength;
            public IntPtr Buffer;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct OBJECT_ATTRIBUTES {
            public uint Length;
            public IntPtr RootDirectory;
            public IntPtr ObjectName;
            public uint Attributes;
            public IntPtr SecurityDescriptor;
            public IntPtr SecurityQualityOfService;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security,
            uint disposition, uint flags, IntPtr template);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool GetFileInformationByHandle(IntPtr handle, out BY_HANDLE_FILE_INFORMATION information);
        [DllImport("ntdll.dll")]
        static extern int NtSetInformationFile(IntPtr handle, out IO_STATUS_BLOCK ioStatus, IntPtr information, uint size, int informationClass);
        [DllImport("ntdll.dll")]
        static extern int NtCreateFile(out IntPtr handle, uint desiredAccess, ref OBJECT_ATTRIBUTES attributes,
            out IO_STATUS_BLOCK ioStatus, IntPtr allocationSize, uint fileAttributes, uint shareAccess,
            uint createDisposition, uint createOptions, IntPtr eaBuffer, uint eaLength);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool SetFileInformationByHandle(IntPtr handle, int informationClass,
            ref FILE_DISPOSITION_INFO information, uint size);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);

        readonly List<IntPtr> componentHandles = new List<IntPtr>();
        IntPtr itemHandle = InvalidHandle;
        IntPtr sourceParentHandle = InvalidHandle;
        IntPtr destinationParentHandle = InvalidHandle;
        readonly string sourceLeaf;
        readonly string destinationLeaf;
        public bool AtDestination { get; private set; }
        public string Identity { get; private set; }

        DirectoryRenameSession(string itemPath, string sourceParent, string destinationParent, bool atDestination) {
            sourceLeaf = Path.GetFileName(itemPath);
            destinationLeaf = sourceLeaf;
            try {
                foreach (string component in Components(sourceParent, destinationParent))
                    componentHandles.Add(OpenOrdinaryDirectory(component, FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY));
                sourceParentHandle = OpenOrdinaryDirectory(sourceParent, FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY);
                destinationParentHandle = OpenOrdinaryDirectory(destinationParent, FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY);
                itemHandle = OpenOrdinaryDirectory(itemPath, DELETE | FILE_READ_ATTRIBUTES);
                Identity = ReadIdentity(itemHandle);
                AtDestination = atDestination;
            } catch { Dispose(); throw; }
        }

        public static DirectoryRenameSession Open(string itemPath, string sourceParent, string destinationParent, bool atDestination) {
            return new DirectoryRenameSession(Path.GetFullPath(itemPath), Path.GetFullPath(sourceParent), Path.GetFullPath(destinationParent), atDestination);
        }

        public static string ReadPathIdentity(string itemPath) {
            IntPtr handle = InvalidHandle;
            try {
                handle = OpenOrdinaryDirectory(Path.GetFullPath(itemPath), FILE_READ_ATTRIBUTES);
                return ReadIdentity(handle);
            } finally { if (handle != InvalidHandle) CloseHandle(handle); }
        }

        public static string ReadFileIdentity(string itemPath) {
            IntPtr handle = InvalidHandle;
            try {
                handle = CreateFileW(Path.GetFullPath(itemPath), FILE_READ_ATTRIBUTES,
                    FILE_SHARE_READ | FILE_SHARE_WRITE, IntPtr.Zero, OPEN_EXISTING,
                    FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
                if (handle == InvalidHandle) throw new Win32Exception(Marshal.GetLastWin32Error());
                BY_HANDLE_FILE_INFORMATION info;
                if (!GetFileInformationByHandle(handle, out info) ||
                    (info.FileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0)
                    throw new InvalidOperationException();
                return ReadIdentity(handle);
            } finally { if (handle != InvalidHandle) CloseHandle(handle); }
        }

        internal static IEnumerable<string> Components(params string[] paths) {
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (string raw in paths) {
                string full = Path.GetFullPath(raw);
                string current = Path.GetPathRoot(full);
                if (seen.Add(current)) yield return current;
                string remainder = full.Substring(current.Length);
                foreach (string leaf in remainder.Split(new[] { Path.DirectorySeparatorChar }, StringSplitOptions.RemoveEmptyEntries)) {
                    current = Path.Combine(current, leaf);
                    if (seen.Add(current)) yield return current;
                }
            }
        }

        internal static IntPtr OpenOrdinaryDirectory(string path, uint access) {
            IntPtr handle = CreateFileW(path, access, FILE_SHARE_READ | FILE_SHARE_WRITE, IntPtr.Zero,
                OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
            if (handle == InvalidHandle) throw new Win32Exception(Marshal.GetLastWin32Error());
            BY_HANDLE_FILE_INFORMATION info;
            if (!GetFileInformationByHandle(handle, out info) ||
                (info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
                (info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
                int error = Marshal.GetLastWin32Error();
                CloseHandle(handle);
                throw new Win32Exception(error == 0 ? 4390 : error);
            }
            return handle;
        }

        static IntPtr OpenRelativeOrdinaryDirectory(IntPtr parentHandle, string leaf, uint access,
            uint disposition, byte[] securityDescriptor, out bool collision) {
            if (parentHandle == IntPtr.Zero || parentHandle == InvalidHandle || String.IsNullOrEmpty(leaf) ||
                leaf == "." || leaf == ".." || leaf.EndsWith(".", StringComparison.Ordinal) ||
                leaf.EndsWith(" ", StringComparison.Ordinal) || leaf.IndexOf(Path.DirectorySeparatorChar) >= 0 ||
                leaf.IndexOf(Path.AltDirectorySeparatorChar) >= 0 || leaf.IndexOf(':') >= 0)
                throw new ArgumentException("leaf");
            foreach (char character in leaf) if (character < 32) throw new ArgumentException("leaf");

            IntPtr nameBuffer = IntPtr.Zero;
            IntPtr nameStructure = IntPtr.Zero;
            IntPtr securityBuffer = IntPtr.Zero;
            IntPtr handle = InvalidHandle;
            collision = false;
            try {
                nameBuffer = Marshal.StringToHGlobalUni(leaf);
                UNICODE_STRING name = new UNICODE_STRING {
                    Length = checked((ushort)(leaf.Length * 2)),
                    MaximumLength = checked((ushort)((leaf.Length + 1) * 2)),
                    Buffer = nameBuffer,
                };
                nameStructure = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UNICODE_STRING)));
                Marshal.StructureToPtr(name, nameStructure, false);
                OBJECT_ATTRIBUTES attributes = new OBJECT_ATTRIBUTES {
                    Length = (uint)Marshal.SizeOf(typeof(OBJECT_ATTRIBUTES)),
                    RootDirectory = parentHandle,
                    ObjectName = nameStructure,
                    Attributes = OBJ_CASE_INSENSITIVE,
                    SecurityDescriptor = securityBuffer,
                    SecurityQualityOfService = IntPtr.Zero,
                };
                if (securityDescriptor != null && securityDescriptor.Length > 0) {
                    securityBuffer = Marshal.AllocHGlobal(securityDescriptor.Length);
                    Marshal.Copy(securityDescriptor, 0, securityBuffer, securityDescriptor.Length);
                    attributes.SecurityDescriptor = securityBuffer;
                }
                IO_STATUS_BLOCK ioStatus;
                uint options = FILE_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT | FILE_OPEN_FOR_BACKUP_INTENT |
                    FILE_SYNCHRONOUS_IO_NONALERT;
                int status = NtCreateFile(out handle, access, ref attributes, out ioStatus, IntPtr.Zero,
                    FILE_ATTRIBUTE_DIRECTORY, FILE_SHARE_READ | FILE_SHARE_WRITE, disposition, options, IntPtr.Zero, 0);
                if (status == STATUS_OBJECT_NAME_COLLISION) {
                    collision = true;
                    return InvalidHandle;
                }
                if (status != 0 || handle == InvalidHandle)
                    throw new InvalidOperationException("native-create-status:" + status.ToString("x8"));
                BY_HANDLE_FILE_INFORMATION information;
                if (!GetFileInformationByHandle(handle, out information) ||
                    (information.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
                    (information.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0)
                    throw new InvalidOperationException("native-create-nonordinary");
                IntPtr result = handle;
                handle = InvalidHandle;
                return result;
            } finally {
                if (handle != InvalidHandle) CloseHandle(handle);
                if (securityBuffer != IntPtr.Zero) Marshal.FreeHGlobal(securityBuffer);
                if (nameStructure != IntPtr.Zero) Marshal.FreeHGlobal(nameStructure);
                if (nameBuffer != IntPtr.Zero) Marshal.FreeHGlobal(nameBuffer);
            }
        }

        internal static IntPtr CreateOrdinaryDirectory(IntPtr parentHandle, string leaf) {
            bool collision;
            IntPtr handle = OpenRelativeOrdinaryDirectory(parentHandle, leaf,
                SYNCHRONIZE | FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY | FILE_ADD_SUBDIRECTORY,
                FILE_CREATE, null, out collision);
            if (collision) throw new InvalidOperationException("native-create-collision");
            return handle;
        }

        internal static IntPtr CreateProtectedOrdinaryDirectory(IntPtr parentHandle, string leaf, out bool collision) {
            return OpenRelativeOrdinaryDirectory(parentHandle, leaf,
                SYNCHRONIZE | FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY | FILE_ADD_SUBDIRECTORY,
                FILE_CREATE, StateFileSecurity.ClosedDirectorySecurityDescriptor(), out collision);
        }

        internal static IntPtr OpenExistingOrdinaryDirectoryForReplacement(IntPtr parentHandle, string leaf) {
            bool collision;
            return OpenRelativeOrdinaryDirectory(parentHandle, leaf,
                SYNCHRONIZE | DELETE | FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY | FILE_ADD_SUBDIRECTORY,
                FILE_OPEN, null, out collision);
        }

        internal static void DeleteEmptyDirectory(IntPtr handle) {
            FILE_DISPOSITION_INFO information = new FILE_DISPOSITION_INFO { DeleteFile = true };
            if (!SetFileInformationByHandle(handle, FileDispositionInfo, ref information,
                (uint)Marshal.SizeOf(typeof(FILE_DISPOSITION_INFO))))
                throw new Win32Exception(Marshal.GetLastWin32Error());
        }

        internal static string ReadIdentity(IntPtr handle) {
            BY_HANDLE_FILE_INFORMATION info;
            if (!GetFileInformationByHandle(handle, out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
            return info.VolumeSerialNumber.ToString("x8") + ":" + info.FileIndexHigh.ToString("x8") + info.FileIndexLow.ToString("x8");
        }

        void Rename(IntPtr parentHandle, string leaf) {
            byte[] name = Encoding.Unicode.GetBytes(leaf);
            int rootOffset = IntPtr.Size == 8 ? 8 : 4;
            int lengthOffset = rootOffset + IntPtr.Size;
            int nameOffset = lengthOffset + sizeof(uint);
            int size = nameOffset + name.Length;
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try {
                for (int i = 0; i < size; i++) Marshal.WriteByte(buffer, i, 0);
                Marshal.WriteByte(buffer, 0, 0);
                Marshal.WriteIntPtr(buffer, rootOffset, parentHandle);
                Marshal.WriteInt32(buffer, lengthOffset, name.Length);
                Marshal.Copy(name, 0, IntPtr.Add(buffer, nameOffset), name.Length);
                IO_STATUS_BLOCK ioStatus;
                int status = NtSetInformationFile(itemHandle, out ioStatus, buffer, (uint)size, FileRenameInformation);
                if (status != 0) throw new InvalidOperationException("native-rename-status:" + status.ToString("x8"));
            } finally { Marshal.FreeHGlobal(buffer); }
        }

        public void MoveToDestination(bool failIdentityVerification) {
            if (AtDestination) throw new InvalidOperationException();
            Rename(destinationParentHandle, destinationLeaf);
            AtDestination = true;
            if (failIdentityVerification || !String.Equals(ReadIdentity(itemHandle), Identity, StringComparison.Ordinal))
                throw new InvalidOperationException();
        }

        public void MoveToSource() {
            if (!AtDestination) throw new InvalidOperationException();
            Rename(sourceParentHandle, sourceLeaf);
            AtDestination = false;
            if (!String.Equals(ReadIdentity(itemHandle), Identity, StringComparison.Ordinal))
                throw new InvalidOperationException();
        }

        public void Dispose() {
            if (itemHandle != InvalidHandle) { CloseHandle(itemHandle); itemHandle = InvalidHandle; }
            if (sourceParentHandle != InvalidHandle) { CloseHandle(sourceParentHandle); sourceParentHandle = InvalidHandle; }
            if (destinationParentHandle != InvalidHandle) { CloseHandle(destinationParentHandle); destinationParentHandle = InvalidHandle; }
            foreach (IntPtr handle in componentHandles) if (handle != InvalidHandle) CloseHandle(handle);
            componentHandles.Clear();
        }
    }

    public static class OwnedDirectoryCleaner {
        const uint DELETE = 0x00010000;
        const uint SYNCHRONIZE = 0x00100000;
        const uint FILE_READ_ATTRIBUTES = 0x00000080;
        const uint FILE_LIST_DIRECTORY = 0x00000001;
        const uint FILE_SHARE_READ = 0x00000001;
        const uint FILE_SHARE_WRITE = 0x00000002;
        const uint OPEN_EXISTING = 3;
        const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
        const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
        const uint FILE_OPEN_REPARSE_POINT = 0x00200000;
        const uint FILE_OPEN_FOR_BACKUP_INTENT = 0x00004000;
        const uint FILE_SYNCHRONOUS_IO_NONALERT = 0x00000020;
        const uint FILE_DIRECTORY_FILE = 0x00000001;
        const uint FILE_NON_DIRECTORY_FILE = 0x00000040;
        const uint OBJ_CASE_INSENSITIVE = 0x00000040;
        const uint FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
        const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
        const uint INVALID_FILE_ATTRIBUTES = 0xffffffff;
        const int ERROR_FILE_NOT_FOUND = 2;
        const int ERROR_PATH_NOT_FOUND = 3;
        const int ERROR_ACCESS_DENIED = 5;
        const int ERROR_NO_MORE_FILES = 18;
        const int ERROR_SHARING_VIOLATION = 32;
        const int FileAttributeTagInfo = 9;
        const int FileIdBothDirectoryInfo = 10;
        const int FileDispositionInfo = 4;
        static readonly IntPtr InvalidHandle = new IntPtr(-1);

        public static Action<string> BeforeChildOpenForTest { get; set; }
        public static Action<string> AfterChildOpenForTest { get; set; }
        public static Action<string> BeforeRootDispositionForTest { get; set; }

        enum CleanupResult { Removed, Retained, Invalid }

        [StructLayout(LayoutKind.Sequential)]
        struct FILE_ATTRIBUTE_TAG_INFO {
            public uint FileAttributes;
            public uint ReparseTag;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct FILE_DISPOSITION_INFO {
            [MarshalAs(UnmanagedType.Bool)] public bool DeleteFile;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct IO_STATUS_BLOCK {
            public IntPtr Status;
            public IntPtr Information;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct UNICODE_STRING {
            public ushort Length;
            public ushort MaximumLength;
            public IntPtr Buffer;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct OBJECT_ATTRIBUTES {
            public uint Length;
            public IntPtr RootDirectory;
            public IntPtr ObjectName;
            public uint Attributes;
            public IntPtr SecurityDescriptor;
            public IntPtr SecurityQualityOfService;
        }

        sealed class DirectoryEntrySnapshot {
            public string Name;
            public uint Attributes;
            public uint ReparseTag;
            public ulong FileId;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security,
            uint disposition, uint flags, IntPtr template);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool GetFileInformationByHandleEx(IntPtr handle, int informationClass,
            out FILE_ATTRIBUTE_TAG_INFO information, uint size);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool GetFileInformationByHandleEx(IntPtr handle, int informationClass,
            IntPtr information, uint size);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool SetFileInformationByHandle(IntPtr handle, int informationClass,
            ref FILE_DISPOSITION_INFO information, uint size);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern uint GetFileAttributesW(string path);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
        [DllImport("ntdll.dll")]
        static extern int NtOpenFile(out IntPtr handle, uint desiredAccess, ref OBJECT_ATTRIBUTES attributes,
            out IO_STATUS_BLOCK ioStatus, uint shareAccess, uint openOptions);

        static bool IsStableIdentity(string value) {
            if (value == null || value.Length != 25 || value[8] != ':') return false;
            for (int index = 0; index < value.Length; index++) {
                if (index == 8) continue;
                char character = value[index];
                if (!((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f'))) return false;
            }
            return true;
        }

        static string CanonicalOwnedRoot(string rootPath) {
            if (String.IsNullOrWhiteSpace(rootPath) || rootPath.StartsWith(@"\\?\", StringComparison.Ordinal) ||
                rootPath.StartsWith(@"\\.\", StringComparison.Ordinal) || rootPath.StartsWith(@"\\", StringComparison.Ordinal))
                throw new ArgumentException();
            string full = Path.GetFullPath(rootPath).TrimEnd(Path.DirectorySeparatorChar);
            string supplied = rootPath.TrimEnd(Path.DirectorySeparatorChar);
            if (full.Length < 3 || full[1] != ':' || full[2] != Path.DirectorySeparatorChar ||
                full.IndexOf(':', 2) >= 0 || !String.Equals(full, supplied, StringComparison.OrdinalIgnoreCase))
                throw new ArgumentException();
            return full;
        }

        static bool IsSafeLeaf(string leaf) {
            if (String.IsNullOrEmpty(leaf) || leaf == "." || leaf == ".." || leaf.EndsWith(".", StringComparison.Ordinal) ||
                leaf.EndsWith(" ", StringComparison.Ordinal) || leaf.IndexOf(Path.DirectorySeparatorChar) >= 0 ||
                leaf.IndexOf(Path.AltDirectorySeparatorChar) >= 0 || leaf.IndexOf(':') >= 0) return false;
            foreach (char character in leaf) if (character < 32) return false;
            return true;
        }

        static string BoundedChildPath(string directoryPath, string canonicalRoot, string leaf) {
            if (!IsSafeLeaf(leaf)) throw new InvalidOperationException();
            string child = Path.GetFullPath(Path.Combine(directoryPath, leaf));
            string rootPrefix = canonicalRoot + Path.DirectorySeparatorChar;
            if (!child.StartsWith(rootPrefix, StringComparison.OrdinalIgnoreCase) ||
                !String.Equals(Path.GetDirectoryName(child), directoryPath, StringComparison.OrdinalIgnoreCase) ||
                !String.Equals(Path.GetFileName(child), leaf, StringComparison.Ordinal)) throw new InvalidOperationException();
            return child;
        }

        static IntPtr OpenEntry(IntPtr parentHandle, string leaf, bool directory) {
            uint access = DELETE | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
            if (directory) access |= FILE_LIST_DIRECTORY;
            IntPtr nameBuffer = IntPtr.Zero;
            IntPtr nameStructure = IntPtr.Zero;
            try {
                nameBuffer = Marshal.StringToHGlobalUni(leaf);
                UNICODE_STRING name = new UNICODE_STRING {
                    Length = checked((ushort)(leaf.Length * 2)),
                    MaximumLength = checked((ushort)((leaf.Length + 1) * 2)),
                    Buffer = nameBuffer,
                };
                nameStructure = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UNICODE_STRING)));
                Marshal.StructureToPtr(name, nameStructure, false);
                OBJECT_ATTRIBUTES attributes = new OBJECT_ATTRIBUTES {
                    Length = (uint)Marshal.SizeOf(typeof(OBJECT_ATTRIBUTES)),
                    RootDirectory = parentHandle,
                    ObjectName = nameStructure,
                    Attributes = OBJ_CASE_INSENSITIVE,
                    SecurityDescriptor = IntPtr.Zero,
                    SecurityQualityOfService = IntPtr.Zero,
                };
                IO_STATUS_BLOCK ioStatus;
                IntPtr handle;
                uint options = FILE_OPEN_REPARSE_POINT | FILE_OPEN_FOR_BACKUP_INTENT | FILE_SYNCHRONOUS_IO_NONALERT |
                    (directory ? FILE_DIRECTORY_FILE : FILE_NON_DIRECTORY_FILE);
                int status = NtOpenFile(out handle, access, ref attributes, out ioStatus, FILE_SHARE_READ, options);
                if (status != 0 || handle == InvalidHandle) throw new InvalidOperationException("native-open-status:" + status.ToString("x8"));
                return handle;
            } finally {
                if (nameStructure != IntPtr.Zero) Marshal.FreeHGlobal(nameStructure);
                if (nameBuffer != IntPtr.Zero) Marshal.FreeHGlobal(nameBuffer);
            }
        }

        static IntPtr OpenRoot(string path) {
            IntPtr handle = CreateFileW(path, DELETE | FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY,
                FILE_SHARE_READ, IntPtr.Zero, OPEN_EXISTING,
                FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, IntPtr.Zero);
            if (handle == InvalidHandle) throw new Win32Exception(Marshal.GetLastWin32Error());
            return handle;
        }

        static FILE_ATTRIBUTE_TAG_INFO ReadTag(IntPtr handle) {
            FILE_ATTRIBUTE_TAG_INFO information;
            if (!GetFileInformationByHandleEx(handle, FileAttributeTagInfo, out information,
                (uint)Marshal.SizeOf(typeof(FILE_ATTRIBUTE_TAG_INFO))))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            return information;
        }

        static bool EnumerationMatchesHandle(DirectoryEntrySnapshot enumerated, FILE_ATTRIBUTE_TAG_INFO opened,
            string openedIdentity) {
            uint typeMask = FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT;
            if ((enumerated.Attributes & typeMask) != (opened.FileAttributes & typeMask)) return false;
            if ((opened.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 && enumerated.ReparseTag != opened.ReparseTag) return false;
            if (!IsStableIdentity(openedIdentity)) return false;
            return Convert.ToUInt64(openedIdentity.Substring(9), 16) == enumerated.FileId;
        }

        static CleanupResult ReadDirectoryEntries(IntPtr directoryHandle, out List<DirectoryEntrySnapshot> entries) {
            const int bufferSize = 65536;
            const int headerSize = 104;
            entries = new List<DirectoryEntrySnapshot>();
            IntPtr buffer = Marshal.AllocHGlobal(bufferSize);
            try {
                while (true) {
                    if (!GetFileInformationByHandleEx(directoryHandle, FileIdBothDirectoryInfo, buffer, bufferSize)) {
                        int error = Marshal.GetLastWin32Error();
                        return error == ERROR_NO_MORE_FILES ? CleanupResult.Removed : CleanupResult.Retained;
                    }
                    int offset = 0;
                    while (true) {
                        if (offset < 0 || offset > bufferSize - headerSize) return CleanupResult.Invalid;
                        IntPtr current = IntPtr.Add(buffer, offset);
                        uint nextOffset = unchecked((uint)Marshal.ReadInt32(current, 0));
                        uint nameLength = unchecked((uint)Marshal.ReadInt32(current, 60));
                        if ((nameLength & 1) != 0 || nameLength > bufferSize - offset - headerSize)
                            return CleanupResult.Invalid;
                        string name = Marshal.PtrToStringUni(IntPtr.Add(current, headerSize), (int)nameLength / 2);
                        entries.Add(new DirectoryEntrySnapshot {
                            Name = name,
                            Attributes = unchecked((uint)Marshal.ReadInt32(current, 56)),
                            ReparseTag = unchecked((uint)Marshal.ReadInt32(current, 64)),
                            FileId = unchecked((ulong)Marshal.ReadInt64(current, 96)),
                        });
                        if (nextOffset == 0) break;
                        if (nextOffset < headerSize || nextOffset > bufferSize - offset) return CleanupResult.Invalid;
                        offset += (int)nextOffset;
                    }
                }
            } finally { Marshal.FreeHGlobal(buffer); }
        }

        static CleanupResult MarkDelete(IntPtr handle) {
            FILE_DISPOSITION_INFO disposition = new FILE_DISPOSITION_INFO { DeleteFile = true };
            return SetFileInformationByHandle(handle, FileDispositionInfo, ref disposition,
                (uint)Marshal.SizeOf(typeof(FILE_DISPOSITION_INFO))) ? CleanupResult.Removed : CleanupResult.Retained;
        }

        static CleanupResult CleanDirectory(string directoryPath, IntPtr directoryHandle, string canonicalRoot, bool root) {
            List<DirectoryEntrySnapshot> entries;
            CleanupResult enumerationResult = ReadDirectoryEntries(directoryHandle, out entries);
            if (enumerationResult != CleanupResult.Removed) return enumerationResult;
            foreach (DirectoryEntrySnapshot data in entries) {
                    string leaf = data.Name;
                    if (leaf != "." && leaf != "..") {
                        string childPath;
                        try { childPath = BoundedChildPath(directoryPath, canonicalRoot, leaf); }
                        catch { return CleanupResult.Invalid; }
                        try { if (BeforeChildOpenForTest != null) BeforeChildOpenForTest(childPath); }
                        catch { return CleanupResult.Retained; }

                        bool enumeratedDirectory = (data.Attributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
                        IntPtr childHandle = InvalidHandle;
                        CleanupResult childResult;
                        try {
                            childHandle = OpenEntry(directoryHandle, leaf, enumeratedDirectory);
                            FILE_ATTRIBUTE_TAG_INFO opened = ReadTag(childHandle);
                            string openedIdentity = DirectoryRenameSession.ReadIdentity(childHandle);
                            if (!EnumerationMatchesHandle(data, opened, openedIdentity)) return CleanupResult.Retained;
                            try { if (AfterChildOpenForTest != null) AfterChildOpenForTest(childPath); }
                            catch { return CleanupResult.Retained; }
                            bool ordinaryDirectory = (opened.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0 &&
                                (opened.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0;
                            childResult = ordinaryDirectory
                                ? CleanDirectory(childPath, childHandle, canonicalRoot, false)
                                : MarkDelete(childHandle);
                        } catch { return CleanupResult.Retained; }
                        finally { if (childHandle != InvalidHandle) CloseHandle(childHandle); }
                        if (childResult != CleanupResult.Removed) return childResult;
                    }
            }

            if (root) {
                try { if (BeforeRootDispositionForTest != null) BeforeRootDispositionForTest(directoryPath); }
                catch { return CleanupResult.Retained; }
                try {
                    FILE_ATTRIBUTE_TAG_INFO rootInformation = ReadTag(directoryHandle);
                    if ((rootInformation.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
                        (rootInformation.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0)
                        return CleanupResult.Retained;
                } catch { return CleanupResult.Retained; }
            }
            return MarkDelete(directoryHandle);
        }

        static string ProjectAfterClose(string rootPath, CleanupResult result) {
            if (result == CleanupResult.Invalid) return "invalid";
            if (result == CleanupResult.Retained) return "retained";
            uint attributes = GetFileAttributesW(rootPath);
            if (attributes != INVALID_FILE_ATTRIBUTES) return "retained";
            int error = Marshal.GetLastWin32Error();
            return error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND ? "removed" : "invalid";
        }

        static string MapRootOpenFailure(Win32Exception error) {
            if (error.NativeErrorCode == ERROR_FILE_NOT_FOUND || error.NativeErrorCode == ERROR_PATH_NOT_FOUND) return "invalid";
            if (error.NativeErrorCode == ERROR_SHARING_VIOLATION || error.NativeErrorCode == ERROR_ACCESS_DENIED) return "retained";
            return "invalid";
        }

        static IntPtr OpenValidatedRoot(string canonicalRoot, string expectedStableIdentity, List<IntPtr> ancestors) {
            foreach (string component in DirectoryRenameSession.Components(canonicalRoot)) {
                if (String.Equals(component.TrimEnd(Path.DirectorySeparatorChar), canonicalRoot, StringComparison.OrdinalIgnoreCase)) continue;
                ancestors.Add(DirectoryRenameSession.OpenOrdinaryDirectory(component, FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY));
            }
            IntPtr root = OpenRoot(canonicalRoot);
            try {
                FILE_ATTRIBUTE_TAG_INFO information = ReadTag(root);
                if ((information.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
                    (information.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 ||
                    !String.Equals(DirectoryRenameSession.ReadIdentity(root), expectedStableIdentity, StringComparison.Ordinal))
                    throw new InvalidOperationException();
                return root;
            } catch { CloseHandle(root); throw; }
        }

        public static string RemoveTreeNoFollow(string rootPath, string expectedStableIdentity) {
            if (!IsStableIdentity(expectedStableIdentity)) return "invalid";
            string canonicalRoot;
            try { canonicalRoot = CanonicalOwnedRoot(rootPath); }
            catch { return "invalid"; }
            var ancestors = new List<IntPtr>();
            IntPtr root = InvalidHandle;
            CleanupResult result;
            try {
                root = OpenValidatedRoot(canonicalRoot, expectedStableIdentity, ancestors);
                result = CleanDirectory(canonicalRoot, root, canonicalRoot, true);
            } catch (Win32Exception error) { return MapRootOpenFailure(error); }
            catch { return "invalid"; }
            finally {
                if (root != InvalidHandle) CloseHandle(root);
                foreach (IntPtr ancestor in ancestors) if (ancestor != InvalidHandle) CloseHandle(ancestor);
            }
            return ProjectAfterClose(canonicalRoot, result);
        }

        public static string RemoveEmptyNoFollow(string rootPath, string expectedStableIdentity) {
            if (!IsStableIdentity(expectedStableIdentity)) return "invalid";
            string canonicalRoot;
            try { canonicalRoot = CanonicalOwnedRoot(rootPath); }
            catch { return "invalid"; }
            var ancestors = new List<IntPtr>();
            IntPtr root = InvalidHandle;
            CleanupResult result;
            try {
                root = OpenValidatedRoot(canonicalRoot, expectedStableIdentity, ancestors);
                try { if (BeforeRootDispositionForTest != null) BeforeRootDispositionForTest(rootPath); }
                catch { return "retained"; }
                FILE_ATTRIBUTE_TAG_INFO rootInformation = ReadTag(root);
                if ((rootInformation.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
                    (rootInformation.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 ||
                    !String.Equals(DirectoryRenameSession.ReadIdentity(root), expectedStableIdentity, StringComparison.Ordinal))
                    result = CleanupResult.Retained;
                else
                    result = MarkDelete(root);
            } catch (Win32Exception error) { return MapRootOpenFailure(error); }
            catch { return "invalid"; }
            finally {
                if (root != InvalidHandle) CloseHandle(root);
                foreach (IntPtr ancestor in ancestors) if (ancestor != InvalidHandle) CloseHandle(ancestor);
            }
            return ProjectAfterClose(canonicalRoot, result);
        }
    }

    public sealed class DirectoryComponentGuard : IDisposable {
        const uint FILE_READ_ATTRIBUTES = 0x00000080;
        const uint FILE_LIST_DIRECTORY = 0x00000001;
        const uint FILE_ADD_SUBDIRECTORY = 0x00000004;
        static readonly IntPtr InvalidHandle = new IntPtr(-1);
        readonly List<IntPtr> handles = new List<IntPtr>();
        public string Identity { get; private set; }

        DirectoryComponentGuard(string path, bool creationAuthority) {
            try {
                var components = new List<string>(DirectoryRenameSession.Components(Path.GetFullPath(path)));
                for (int index = 0; index < components.Count; index++) {
                    uint access = FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY;
                    if (creationAuthority && index == components.Count - 1) access |= FILE_ADD_SUBDIRECTORY;
                    handles.Add(DirectoryRenameSession.OpenOrdinaryDirectory(components[index], access));
                }
                Identity = DirectoryRenameSession.ReadIdentity(handles[handles.Count - 1]);
            } catch { Dispose(); throw; }
        }

        DirectoryComponentGuard(IntPtr handle) {
            try {
                if (handle == IntPtr.Zero || handle == InvalidHandle) throw new ArgumentException("handle");
                handles.Add(handle);
                Identity = DirectoryRenameSession.ReadIdentity(handle);
            } catch { Dispose(); throw; }
        }

        public static DirectoryComponentGuard Open(string path) {
            return new DirectoryComponentGuard(path, false);
        }

        public static DirectoryComponentGuard OpenForCreation(string path) {
            return new DirectoryComponentGuard(path, true);
        }

        public static DirectoryComponentGuard CreateExclusive(DirectoryComponentGuard parent, string leaf) {
            if (parent == null || parent.handles.Count == 0) throw new ArgumentException("parent");
            return new DirectoryComponentGuard(DirectoryRenameSession.CreateOrdinaryDirectory(
                parent.handles[parent.handles.Count - 1], leaf));
        }

        public static DirectoryComponentGuard OpenOrCreateProtectedStateParent(
            DirectoryComponentGuard parent, string leaf, string expectedPath) {
            if (parent == null || parent.handles.Count == 0) throw new ArgumentException("parent");
            DirectoryComponentGuard guard = null;
            try {
                bool collision;
                IntPtr created = DirectoryRenameSession.CreateProtectedOrdinaryDirectory(
                    parent.handles[parent.handles.Count - 1], leaf, out collision);
                if (!collision) {
                    guard = new DirectoryComponentGuard(created);
                    if (!StateFileSecurity.ValidateParentIdentity(expectedPath, guard.Identity))
                        throw new InvalidOperationException("protected-parent-validation");
                    DirectoryComponentGuard result = guard;
                    guard = null;
                    return result;
                }

                guard = new DirectoryComponentGuard(
                    DirectoryRenameSession.OpenExistingOrdinaryDirectoryForReplacement(
                        parent.handles[parent.handles.Count - 1], leaf));
                if (!guard.MatchesPath(expectedPath)) throw new InvalidOperationException("parent-identity-drift");
                if (StateFileSecurity.ValidateParentIdentity(expectedPath, guard.Identity)) {
                    DirectoryComponentGuard existing = guard;
                    guard = null;
                    return existing;
                }

                DirectoryRenameSession.DeleteEmptyDirectory(guard.handles[guard.handles.Count - 1]);
                guard.Dispose();
                guard = null;
                created = DirectoryRenameSession.CreateProtectedOrdinaryDirectory(
                    parent.handles[parent.handles.Count - 1], leaf, out collision);
                if (collision) throw new InvalidOperationException("protected-parent-create-collision");
                guard = new DirectoryComponentGuard(created);
                if (!StateFileSecurity.ValidateParentIdentity(expectedPath, guard.Identity))
                    throw new InvalidOperationException("protected-parent-validation");
                DirectoryComponentGuard replacement = guard;
                guard = null;
                return replacement;
            } finally { if (guard != null) guard.Dispose(); }
        }

        public bool MatchesPath(string path) {
            try {
                return handles.Count > 0 && String.Equals(
                    DirectoryRenameSession.ReadPathIdentity(Path.GetFullPath(path)), Identity,
                    StringComparison.Ordinal);
            } catch { return false; }
        }

        public void Dispose() {
            foreach (IntPtr handle in handles) if (handle != InvalidHandle) CloseHandle(handle);
            handles.Clear();
        }

        [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
    }
}
'@ -Language CSharp -ErrorAction Stop
}

function Invoke-IntentArcPreflightOutPreservation {
    param(
        [object[]] $ArgumentsVector = @(),
        [object] $TestContract = $null
    )

    $schema = 'intentarc.preflight-out-preservation-result/v2'
    $resultStatuses = @('PASS', 'RECOVERED', 'REFUSED', 'FAIL')
    $resultCategories = @(
        'none', 'recovery-restored', 'arguments-invalid', 'repository-invalid', 'preflight-id-used', 'out-source-invalid',
        'preservation-state-invalid', 'state-evidence-invalid', 'pnpm-binding-invalid', 'out-preservation-failed',
        'preflight-start-failed', 'preflight-failed', 'preflight-timeout', 'preflight-canceled', 'child-settlement-failed',
        'out-restoration-conflict', 'out-restoration-failed', 'receipt-invalid', 'residue-invalid'
    )
    $cleanupCategories = @('none', 'residue-invalid')
    $resultPhases = @('validated', 'prepared', 'preserved', 'child-started', 'child-settled', 'restored', 'complete')
    $result = {
        param(
            [string] $Status,
            [string] $Category,
            [string] $Phase = 'validated',
            [bool] $ChildStarted = $false,
            [Nullable[int]] $ChildExitCode = $null,
            [bool] $OutRestored = $false,
            [string] $CleanupCategory = 'none'
        )
        if ($resultStatuses -cnotcontains $Status -or $resultCategories -cnotcontains $Category -or
            $cleanupCategories -cnotcontains $CleanupCategory -or $resultPhases -cnotcontains $Phase) {
            throw 'result-enum-invalid'
        }
        return [ordered]@{
            schema = $schema
            status = $Status
            category = $Category
            cleanupCategory = $CleanupCategory
            phase = $Phase
            childStarted = $ChildStarted
            childExitCode = $ChildExitCode
            outRestored = $OutRestored
        }
    }
    $refuse = {
        param([string] $Category)
        return & $result 'REFUSED' $Category
    }
    $isUnsafeText = {
        param([object] $Value)
        if ($Value -isnot [string] -or [string]::IsNullOrEmpty($Value)) { return $true }
        return $Value.IndexOfAny([char[]]@(
            [char]0, [char]10, [char]13, [char]34, [char]39,
            [char]42, [char]63, [char]91, [char]93
        )) -ge 0
    }
    $isFullyQualifiedLocalWindowsPath = {
        param([string] $Value)
        if ($Value.StartsWith('\\?\', [StringComparison]::Ordinal) -or
            $Value.StartsWith('\\.\', [StringComparison]::Ordinal)) { return $false }
        return $Value -match '^[A-Za-z]:\\'
    }
    $probeExactEntry = {
        param([string] $LiteralPath)
        try {
            [void](Get-Item -LiteralPath $LiteralPath -Force -ErrorAction Stop)
            [void][IO.File]::GetAttributes($LiteralPath)
            return 'present'
        } catch [Management.Automation.ItemNotFoundException] {
            return 'absent'
        } catch {
            return 'indeterminate'
        }
    }
    $probeRecoveryExactEntry = {
        param([string] $LiteralPath)
        $itemObserved = $false
        try {
            $item = Get-Item -LiteralPath $LiteralPath -Force -ErrorAction Stop
            $itemObserved = $true
            $attributes = [IO.File]::GetAttributes($LiteralPath)
            if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return 'reparse' }
            if ($item.PSIsContainer -and ($attributes -band [IO.FileAttributes]::Directory) -ne 0) { return 'directory' }
            if (-not $item.PSIsContainer -and ($attributes -band [IO.FileAttributes]::Directory) -eq 0) { return 'file' }
            return 'indeterminate'
        } catch [Management.Automation.ItemNotFoundException] {
            return $(if ($itemObserved) { 'indeterminate' } else { 'absent' })
        } catch [IO.FileNotFoundException] {
            return $(if ($itemObserved) { 'indeterminate' } else { 'absent' })
        } catch [IO.DirectoryNotFoundException] {
            return $(if ($itemObserved) { 'indeterminate' } else { 'absent' })
        } catch {
            return 'indeterminate'
        }
    }
    $getOrdinaryDirectoryIdentity = {
        param([string] $LiteralPath)
        try {
            if (-not [IO.Directory]::Exists($LiteralPath) -or [IO.File]::Exists($LiteralPath)) { return $null }
            $item = Get-Item -LiteralPath $LiteralPath -Force -ErrorAction Stop
            $attributes = [IO.File]::GetAttributes($LiteralPath)
            if (-not $item.PSIsContainer -or (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { return $null }
            return [ordered]@{
                canonicalPath = [IO.Path]::GetFullPath($item.FullName)
                attributes = [int]$attributes
                creationTimeUtc = $item.CreationTimeUtc.ToString('o')
                lastWriteTimeUtc = $item.LastWriteTimeUtc.ToString('o')
            }
        } catch { return $null }
    }
    $getOrdinaryFile = {
        param([string] $LiteralPath)
        try {
            if (-not [IO.File]::Exists($LiteralPath) -or [IO.Directory]::Exists($LiteralPath)) { return $null }
            $item = Get-Item -LiteralPath $LiteralPath -Force -ErrorAction Stop
            $attributes = [IO.File]::GetAttributes($LiteralPath)
            if ($item.PSIsContainer -or (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { return $null }
            return $item
        } catch { return $null }
    }
    $getStableDirectoryIdentity = {
        param($Contract, [string] $LiteralPath)
        try {
            if ($null -ne $TestContract -and $null -ne $Contract.getStableDirectoryIdentity) {
                return [string](& $Contract.getStableDirectoryIdentity $LiteralPath)
            }
            Initialize-IntentArcPreflightNativeProcessType
            return [IntentArc.Preflight.DirectoryRenameSession]::ReadPathIdentity($LiteralPath)
        } catch { return $null }
    }
    $getStableFileIdentity = {
        param($Contract, [string] $LiteralPath)
        try {
            if ($null -ne $TestContract -and $null -ne $Contract.getStableFileIdentity) {
                return [string](& $Contract.getStableFileIdentity $LiteralPath)
            }
            Initialize-IntentArcPreflightNativeProcessType
            return [IntentArc.Preflight.DirectoryRenameSession]::ReadFileIdentity($LiteralPath)
        } catch { return $null }
    }
    $getRepositoryState = {
        param($Contract)
        if ($null -ne $TestContract -and $null -ne $Contract.getRepositoryState) {
            return & $Contract.getRepositoryState
        }
        $branch = (& $invokeBoundGit $Contract @('symbolic-ref', '--short', 'HEAD')).Trim()
        $commit = (& $invokeBoundGit $Contract @('rev-parse', 'HEAD')).Trim()
        $statusText = & $invokeBoundGit $Contract @('status', '--porcelain=v1', '--untracked-files=no')
        $rows = if ([string]::IsNullOrEmpty($statusText)) { @() } else { @($statusText.TrimEnd("`r", "`n") -split "`r?`n") }
        return [ordered]@{ branch = $branch; commit = $commit; statusRows = $rows }
    }
    $repositoryMatches = {
        param($Contract, [string] $ExpectedCommit)
        try {
            $state = & $getRepositoryState $Contract
            return $null -ne $state -and
                [string]$state.branch -ceq [string]$Contract.branch -and
                [string]$state.commit -ceq $ExpectedCommit -and
                @($state.statusRows).Count -eq 0
        } catch { return $false }
    }
    $getPnpmSha256 = {
        param($Contract, [string] $Path)
        if ($null -ne $TestContract -and $null -ne $Contract.getPnpmSha256) {
            return [string](& $Contract.getPnpmSha256 $Path)
        }
        $stream = $null
        $sha = $null
        try {
            $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
            $sha = [Security.Cryptography.SHA256]::Create()
            return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
        } finally {
            if ($null -ne $sha) { $sha.Dispose() }
            if ($null -ne $stream) { $stream.Dispose() }
        }
    }
    $getPnpmBinding = {
        param($Contract, [string] $Path)
        try {
            $before = & $getOrdinaryFile $Path
            if ($null -eq $before) { return $null }
            $beforeAttributes = [IO.File]::GetAttributes($Path)
            $beforeStableIdentity = & $getStableFileIdentity $Contract $Path
            if ([string]$beforeStableIdentity -cnotmatch '^[a-f0-9]{8}:[a-f0-9]{16}$') { return $null }
            $binding = [ordered]@{
                canonicalPath = [IO.Path]::GetFullPath($before.FullName)
                attributes = [int]$beforeAttributes
                length = [int64]$before.Length
                creationTimeUtc = $before.CreationTimeUtc.ToString('o')
                lastWriteTimeUtc = $before.LastWriteTimeUtc.ToString('o')
                stableIdentity = $beforeStableIdentity
                sha256 = [string](& $getPnpmSha256 $Contract $Path)
            }
            $after = & $getOrdinaryFile $Path
            if ($null -eq $after) { return $null }
            $afterAttributes = [IO.File]::GetAttributes($Path)
            if (-not [string]::Equals([IO.Path]::GetFullPath($after.FullName), [string]$binding.canonicalPath, [StringComparison]::OrdinalIgnoreCase) -or
                [int]$afterAttributes -ne [int]$binding.attributes -or
                [int64]$after.Length -ne [int64]$binding.length -or
                $after.CreationTimeUtc.ToString('o') -cne [string]$binding.creationTimeUtc -or
                $after.LastWriteTimeUtc.ToString('o') -cne [string]$binding.lastWriteTimeUtc -or
                [string](& $getStableFileIdentity $Contract $Path) -cne [string]$binding.stableIdentity) {
                return $null
            }
            return $binding
        } catch { return $null }
    }
    $pnpmBindingMatches = {
        param($Contract, [string] $Path, $ExpectedBinding, [string] $ExpectedSha256)
        $actual = & $getPnpmBinding $Contract $Path
        return $null -ne $actual -and $null -ne $ExpectedBinding -and
            [string]::Equals([string]$actual.canonicalPath, [string]$ExpectedBinding.canonicalPath, [StringComparison]::OrdinalIgnoreCase) -and
            [int]$actual.attributes -eq [int]$ExpectedBinding.attributes -and
            [int64]$actual.length -eq [int64]$ExpectedBinding.length -and
            [string]$actual.creationTimeUtc -ceq [string]$ExpectedBinding.creationTimeUtc -and
            [string]$actual.lastWriteTimeUtc -ceq [string]$ExpectedBinding.lastWriteTimeUtc -and
            [string]$actual.stableIdentity -ceq [string]$ExpectedBinding.stableIdentity -and
            [string]$actual.sha256 -ceq $ExpectedSha256
    }
    $identityMatches = {
        param($Expected, [string] $LiteralPath, [string] $ExpectedCanonicalPath)
        $actual = & $getOrdinaryDirectoryIdentity $LiteralPath
        $expectedStableIdentity = if ($Expected -is [Collections.IDictionary] -and $Expected.Contains('stableIdentity')) {
            [string]$Expected.stableIdentity
        } elseif ($null -ne $Expected.PSObject.Properties['stableIdentity']) {
            [string]$Expected.stableIdentity
        } else { $null }
        return $null -ne $actual -and
            [string]::Equals([string]$actual.canonicalPath, $ExpectedCanonicalPath, [StringComparison]::OrdinalIgnoreCase) -and
            [int]$actual.attributes -eq [int]$Expected.attributes -and
            [string]$actual.creationTimeUtc -ceq [string]$Expected.creationTimeUtc -and
            [string]$actual.lastWriteTimeUtc -ceq [string]$Expected.lastWriteTimeUtc -and
            ([string]::IsNullOrEmpty($expectedStableIdentity) -or
                [string](& $getStableDirectoryIdentity $contract $LiteralPath) -ceq $expectedStableIdentity)
    }
    $directoryBoundaryMatches = {
        param($Expected, [string] $LiteralPath)
        return & $identityMatches $Expected $LiteralPath ([IO.Path]::GetFullPath($LiteralPath))
    }
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
    $newOwnedRootEvidence = {
        param($Path, $StableIdentity)
        $ordinary = & $getOrdinaryDirectoryIdentity ([string]$Path)
        if ($null -eq $ordinary -or
            $StableIdentity -isnot [string] -or
            [string]$StableIdentity -cnotmatch '^[a-f0-9]{8}:[a-f0-9]{16}$') {
            throw 'owned-root-evidence-invalid'
        }
        $evidence = [ordered]@{
            canonicalPath = [IO.Path]::GetFullPath([string]$ordinary.canonicalPath)
            attributes = [int]$ordinary.attributes
            stableIdentity = [string]$StableIdentity
        }
        if (-not (& $isValidOwnedRoot $evidence ([string]$Path))) { throw 'owned-root-evidence-invalid' }
        return $evidence
    }
    $heldDirectoryBoundaryMatches = {
        param($Expected, [string] $LiteralPath, $Guard)
        if ($null -eq $Guard -or [string]$Guard.Identity -cne [string]$Expected.stableIdentity) { return $false }
        $actual = & $getOrdinaryDirectoryIdentity $LiteralPath
        return $null -ne $actual -and
            [string]::Equals([string]$actual.canonicalPath, [IO.Path]::GetFullPath($LiteralPath), [StringComparison]::OrdinalIgnoreCase) -and
            [int]$actual.attributes -eq [int]$Expected.attributes
    }
    $removeOwnedRoot = {
        param($Contract, $ExpectedIdentity, [string] $LiteralPath, $Guard)
        try {
            $profilePath = [IO.Path]::GetFullPath([string]$Contract.childProfilePath)
            $localAppDataPath = [IO.Path]::GetFullPath([string]$Contract.childLocalAppDataPath)
            $canonicalPath = [IO.Path]::GetFullPath($LiteralPath)
            if ((-not [string]::Equals($canonicalPath, $profilePath, [StringComparison]::OrdinalIgnoreCase) -and
                -not [string]::Equals($canonicalPath, $localAppDataPath, [StringComparison]::OrdinalIgnoreCase)) -or
                $null -eq $Guard -or $null -eq $ExpectedIdentity) {
                return 'invalid'
            }
            if ($null -ne $TestContract) {
                if ([string]::Equals($canonicalPath, $profilePath, [StringComparison]::OrdinalIgnoreCase) -and
                    $null -ne $Contract.beforeOwnedProfileCleanup) {
                    & $Contract.beforeOwnedProfileCleanup $Guard
                } elseif ([string]::Equals($canonicalPath, $localAppDataPath, [StringComparison]::OrdinalIgnoreCase) -and
                    $null -ne $Contract.beforeOwnedLocalAppDataCleanup) {
                    & $Contract.beforeOwnedLocalAppDataCleanup $Guard
                }
            }
            if ([string]$Guard.Identity -cne [string]$ExpectedIdentity.stableIdentity) { return 'invalid' }
            if (-not (& $stableDirectoryBoundaryMatches $ExpectedIdentity $LiteralPath)) { return 'invalid' }
            $Guard.Dispose()
            if ($null -ne $TestContract -and $null -ne $Contract.afterOwnedRootGuardRelease) {
                & $Contract.afterOwnedRootGuardRelease $LiteralPath
            }
            if (-not (& $stableDirectoryBoundaryMatches $ExpectedIdentity $LiteralPath)) { return 'invalid' }

            Initialize-IntentArcPreflightNativeProcessType
            [IntentArc.Preflight.OwnedDirectoryCleaner]::BeforeChildOpenForTest = $null
            [IntentArc.Preflight.OwnedDirectoryCleaner]::AfterChildOpenForTest = $null
            [IntentArc.Preflight.OwnedDirectoryCleaner]::BeforeRootDispositionForTest = $null
            try {
                if ($null -ne $TestContract -and $null -ne $Contract.beforeOwnedChildOpen) {
                    $beforeChildOpen = { param([string] $Path) & $Contract.beforeOwnedChildOpen $Path }.GetNewClosure()
                    [IntentArc.Preflight.OwnedDirectoryCleaner]::BeforeChildOpenForTest = [Action[string]]$beforeChildOpen
                }
                if ($null -ne $TestContract -and $null -ne $Contract.afterOwnedChildOpen) {
                    $afterChildOpen = { param([string] $Path) & $Contract.afterOwnedChildOpen $Path }.GetNewClosure()
                    [IntentArc.Preflight.OwnedDirectoryCleaner]::AfterChildOpenForTest = [Action[string]]$afterChildOpen
                }
                if ($null -ne $TestContract -and $null -ne $Contract.beforeOwnedRootDisposition) {
                    $beforeRootDisposition = { param([string] $Path) & $Contract.beforeOwnedRootDisposition $Path }.GetNewClosure()
                    [IntentArc.Preflight.OwnedDirectoryCleaner]::BeforeRootDispositionForTest = [Action[string]]$beforeRootDisposition
                }
                $treeResult = [IntentArc.Preflight.OwnedDirectoryCleaner]::RemoveTreeNoFollow(
                    $LiteralPath,
                    [string]$ExpectedIdentity.stableIdentity
                )
            } finally {
                [IntentArc.Preflight.OwnedDirectoryCleaner]::BeforeChildOpenForTest = $null
                [IntentArc.Preflight.OwnedDirectoryCleaner]::AfterChildOpenForTest = $null
                [IntentArc.Preflight.OwnedDirectoryCleaner]::BeforeRootDispositionForTest = $null
            }
            if (@('removed', 'retained', 'invalid') -cnotcontains [string]$treeResult) { return 'invalid' }
            if ([string]$treeResult -cne 'removed') { return [string]$treeResult }
            return $(if ((& $probeExactEntry $LiteralPath) -ceq 'absent') { 'removed' } else { 'retained' })
        } catch { return 'invalid' }
    }
    $removeRunRoot = {
        param($Contract, [bool] $DestinationAbsent, [string] $ProfileStatus, [string] $LocalAppDataStatus)
        if (-not $DestinationAbsent) { return 'invalid' }
        if ($ProfileStatus -cne 'removed' -or $LocalAppDataStatus -cne 'removed') { return 'retained' }
        try {
            $literalPath = [IO.Path]::GetFullPath([string]$Contract.runRoot)
            if ($null -ne $TestContract -and $null -ne $Contract.beforeRunRootCleanup) {
                & $Contract.beforeRunRootCleanup
            }
            $entry = & $probeExactEntry $literalPath
            if ($entry -cne 'present' -or $null -eq $runRootCleanupIdentity -or
                -not (& $stableDirectoryBoundaryMatches $runRootCleanupIdentity $literalPath)) {
                return 'invalid'
            }
            Initialize-IntentArcPreflightNativeProcessType
            [IntentArc.Preflight.OwnedDirectoryCleaner]::BeforeRootDispositionForTest = $null
            try {
                if ($null -ne $TestContract -and $null -ne $Contract.beforeRunRootDisposition) {
                    [IntentArc.Preflight.OwnedDirectoryCleaner]::BeforeRootDispositionForTest =
                        [Action[string]]($Contract.beforeRunRootDisposition)
                }
                $runResult = [IntentArc.Preflight.OwnedDirectoryCleaner]::RemoveEmptyNoFollow(
                    $literalPath,
                    [string]$runRootCleanupIdentity.stableIdentity
                )
            } finally {
                [IntentArc.Preflight.OwnedDirectoryCleaner]::BeforeRootDispositionForTest = $null
            }
            if (@('removed', 'retained', 'invalid') -cnotcontains [string]$runResult) { return 'invalid' }
            return [string]$runResult
        } catch { return 'invalid' }
    }
    $resolvePrimaryOutcome = {
        param([string] $Mode, $Evidence)
        $evidenceKeys = @(
            'phase', 'childStarted', 'childExitCode', 'outRestored', 'cleanupCategory',
            'childSettlementFailed', 'restorationConflict', 'restorationFailed', 'restorationRestored',
            'stateCategory', 'preservationFailed',
            'repositoryInvalid', 'pnpmBindingInvalid', 'childCategory', 'receiptInvalid'
        )
        if (@('-Execute', '-RestoreOnly') -cnotcontains $Mode -or
            -not (& $isStateObject $Evidence) -or -not (& $hasExactKeys $Evidence $evidenceKeys) -or
            $resultPhases -cnotcontains [string]$Evidence.phase -or
            $Evidence.childStarted -isnot [bool] -or
            ($null -ne $Evidence.childExitCode -and $Evidence.childExitCode -isnot [int]) -or
            $Evidence.outRestored -isnot [bool] -or
            $cleanupCategories -cnotcontains [string]$Evidence.cleanupCategory -or
            $Evidence.childSettlementFailed -isnot [bool] -or
            $Evidence.restorationConflict -isnot [bool] -or
            $Evidence.restorationFailed -isnot [bool] -or
            $Evidence.restorationRestored -isnot [bool] -or
            @('none', 'preservation-state-invalid', 'state-evidence-invalid') -cnotcontains [string]$Evidence.stateCategory -or
            $Evidence.preservationFailed -isnot [bool] -or
            $Evidence.repositoryInvalid -isnot [bool] -or
            $Evidence.pnpmBindingInvalid -isnot [bool] -or
            @('none', 'preflight-start-failed', 'preflight-failed', 'preflight-timeout', 'preflight-canceled') -cnotcontains [string]$Evidence.childCategory -or
            $Evidence.receiptInvalid -isnot [bool]) {
            throw 'outcome-evidence-invalid'
        }

        $primary = [ordered]@{ status = 'PASS'; category = 'none'; phase = [string]$Evidence.phase }
        $cleanupCategory = [string]$Evidence.cleanupCategory
        if ($Evidence.childSettlementFailed) {
            $primary.status = 'FAIL'; $primary.category = 'child-settlement-failed'
        } elseif ($Evidence.restorationConflict) {
            $primary.status = 'FAIL'; $primary.category = 'out-restoration-conflict'
        } elseif ($Evidence.restorationFailed) {
            $primary.status = 'FAIL'; $primary.category = 'out-restoration-failed'
        } elseif ($Mode -ceq '-Execute') {
            if ([string]$Evidence.stateCategory -cne 'none') {
                $primary.status = $(if ([string]$Evidence.stateCategory -ceq 'preservation-state-invalid') { 'REFUSED' } else { 'FAIL' })
                $primary.category = [string]$Evidence.stateCategory
            } elseif ($Evidence.preservationFailed) {
                $primary.status = 'FAIL'; $primary.category = 'out-preservation-failed'
            } elseif ($Evidence.repositoryInvalid) {
                $primary.status = 'FAIL'; $primary.category = 'repository-invalid'
            } elseif ($Evidence.pnpmBindingInvalid) {
                $primary.status = 'FAIL'; $primary.category = 'pnpm-binding-invalid'
            } elseif ([string]$Evidence.childCategory -cne 'none') {
                $primary.status = 'FAIL'; $primary.category = [string]$Evidence.childCategory
            } elseif ($Evidence.receiptInvalid) {
                $primary.status = 'FAIL'; $primary.category = 'receipt-invalid'
            } elseif ($cleanupCategory -ceq 'residue-invalid') {
                $primary.status = 'FAIL'; $primary.category = 'residue-invalid'
            }
        } else {
            if ([string]$Evidence.stateCategory -cne 'none') {
                $primary.status = $(if ([string]$Evidence.stateCategory -ceq 'preservation-state-invalid') { 'REFUSED' } else { 'FAIL' })
                $primary.category = [string]$Evidence.stateCategory
            } elseif (-not $Evidence.restorationRestored -or -not $Evidence.outRestored) {
                $primary.status = 'FAIL'; $primary.category = 'out-restoration-failed'
            } else {
                $primary.status = 'RECOVERED'; $primary.category = 'recovery-restored'
            }
        }
        return [ordered]@{
            status = [string]$primary.status
            category = [string]$primary.category
            phase = [string]$primary.phase
            cleanupCategory = $cleanupCategory
        }
    }
    $projectResolvedOutcome = {
        param([string] $Mode, $Evidence)
        $primary = & $resolvePrimaryOutcome $Mode $Evidence
        $projectedChildStarted = if ($Mode -ceq '-RestoreOnly') { $false } else { [bool]$Evidence.childStarted }
        $projectedChildExitCode = if ($Mode -ceq '-RestoreOnly') { $null } else { $Evidence.childExitCode }
        return & $result ([string]$primary.status) ([string]$primary.category) ([string]$primary.phase) $projectedChildStarted $projectedChildExitCode ([bool]$Evidence.outRestored) ([string]$primary.cleanupCategory)
    }
    $protectStateAccess = {
        param($Contract, [string] $LiteralStatePath = $null)
        if ([string]::IsNullOrEmpty($LiteralStatePath)) { $LiteralStatePath = [string]$Contract.statePath }
        $useProductionStateSecurity = $null -eq $TestContract -or $Contract.useProductionStateSecurity -eq $true
        if (-not $useProductionStateSecurity) {
            if ($null -ne $Contract.protectStateAccess) {
                return (& $Contract.protectStateAccess $LiteralStatePath ([string]$Contract.preservationParent)) -eq $true
            }
            [void][IO.Directory]::CreateDirectory([string]$Contract.preservationParent)
            return $true
        }
        Initialize-IntentArcPreflightNativeProcessType
        [IntentArc.Preflight.StateFileSecurity]::ProtectParent([string]$Contract.preservationParent)
        if ([IO.File]::Exists($LiteralStatePath)) {
            [IntentArc.Preflight.StateFileSecurity]::ProtectFile($LiteralStatePath)
        }
        return $true
    }
    $validateStateAccess = {
        param($Contract, [string] $LiteralStatePath = $null)
        if ([string]::IsNullOrEmpty($LiteralStatePath)) { $LiteralStatePath = [string]$Contract.statePath }
        $useProductionStateSecurity = $null -eq $TestContract -or $Contract.useProductionStateSecurity -eq $true
        if (-not $useProductionStateSecurity) {
            if ($null -ne $Contract.validateStateAccess) {
                return (& $Contract.validateStateAccess $LiteralStatePath ([string]$Contract.preservationParent)) -eq $true
            }
            return $true
        }
        Initialize-IntentArcPreflightNativeProcessType
        return [IntentArc.Preflight.StateFileSecurity]::Validate(
            $LiteralStatePath,
            [string]$Contract.preservationParent
        )
    }
    $readLockedJson = {
        param($Contract, [string] $LiteralPath, [string] $BeforeReadHook, [int64] $MaximumBytes)
        $stream = $null
        $reader = $null
        try {
            $beforeIdentity = & $getStableFileIdentity $Contract $LiteralPath
            if ([string]$beforeIdentity -cnotmatch '^[a-f0-9]{8}:[a-f0-9]{16}$') { throw 'file-identity-invalid' }
            $stream = [IO.File]::Open(
                $LiteralPath,
                [IO.FileMode]::Open,
                [IO.FileAccess]::Read,
                [IO.FileShare]::Read
            )
            if ($stream.Length -gt $MaximumBytes) { throw 'file-size-invalid' }
            $beforeRead = $null
            if ($null -ne $TestContract -and -not [string]::IsNullOrEmpty($BeforeReadHook)) {
                if ($Contract -is [Collections.IDictionary] -and $Contract.Contains($BeforeReadHook)) {
                    $beforeRead = $Contract[$BeforeReadHook]
                } elseif ($null -ne $Contract.PSObject.Properties[$BeforeReadHook]) {
                    $beforeRead = $Contract.PSObject.Properties[$BeforeReadHook].Value
                }
            }
            if ($null -ne $beforeRead) {
                & $beforeRead
            }
            if ([string](& $getStableFileIdentity $Contract $LiteralPath) -cne [string]$beforeIdentity) {
                throw 'file-identity-invalid'
            }
            $reader = [IO.StreamReader]::new($stream, [Text.UTF8Encoding]::new($false), $true, 4096, $true)
            $json = $reader.ReadToEnd()
            if ([string](& $getStableFileIdentity $Contract $LiteralPath) -cne [string]$beforeIdentity) {
                throw 'file-identity-invalid'
            }
            return $json | ConvertFrom-Json -ErrorAction Stop
        } finally {
            if ($null -ne $reader) { $reader.Dispose() }
            if ($null -ne $stream) { $stream.Dispose() }
        }
    }
    $readLockedState = {
        param($Contract)
        if (-not (& $validateStateAccess $Contract)) { throw 'state-access-invalid' }
        $stateValue = & $readLockedJson $Contract ([string]$Contract.statePath) 'beforeStateRead' 65536
        if (-not (& $validateStateAccess $Contract)) { throw 'state-access-invalid' }
        return $stateValue
    }
    $journal = [ordered]@{ lastDurablePhase = 'validated' }
    $writeState = {
        param($Contract, $State)
        if (-not (& $isValidState $Contract $State $expectedCommit $pnpmExecutable $expectedPnpmSha256)) {
            throw 'state-invalid'
        }
        if ($null -eq $preservationParentSetupGuard -or
            -not $preservationParentSetupGuard.MatchesPath([string]$Contract.preservationParent)) {
            throw 'state-parent-authority-invalid'
        }
        if (-not (& $protectStateAccess $Contract)) { throw 'state-access-invalid' }
        if ($null -ne $TestContract -and $null -ne $Contract.beforeStatePersistence) {
            & $Contract.beforeStatePersistence $State
        }
        $temporary = [string]$Contract.statePath + '.tmp.' + [Guid]::NewGuid().ToString('N')
        $stream = $null
        try {
            $json = $State | ConvertTo-Json -Depth 8 -Compress
            $bytes = [Text.UTF8Encoding]::new($false).GetBytes($json)
            $stream = [IO.FileStream]::new(
                $temporary,
                [IO.FileMode]::CreateNew,
                [IO.FileAccess]::Write,
                [IO.FileShare]::None,
                4096,
                [IO.FileOptions]::WriteThrough
            )
            $stream.Write($bytes, 0, $bytes.Length)
            $stream.Flush($true)
            $stream.Dispose()
            $stream = $null
            if (-not (& $protectStateAccess $Contract $temporary) -or
                -not (& $validateStateAccess $Contract $temporary)) {
                throw 'state-access-invalid'
            }
            if ($null -ne $TestContract -and $null -ne $Contract.beforeStatePromotion) {
                & $Contract.beforeStatePromotion $State $temporary
            }
            Initialize-IntentArcPreflightNativeProcessType
            [IntentArc.Preflight.StateFileSecurity]::PromoteStateFile($temporary, [string]$Contract.statePath)
            if (-not (& $protectStateAccess $Contract) -or -not (& $validateStateAccess $Contract)) {
                throw 'state-access-invalid'
            }
            if (-not $preservationParentSetupGuard.MatchesPath([string]$Contract.preservationParent)) {
                throw 'state-parent-authority-invalid'
            }
            $persisted = & $readLockedState $Contract
            if (-not (& $isValidState $Contract $persisted $expectedCommit $pnpmExecutable $expectedPnpmSha256) -or
                [string]($persisted | ConvertTo-Json -Depth 8 -Compress) -cne [string]$json) {
                throw 'state-reread-invalid'
            }
            $journal.lastDurablePhase = [string]$State.phase
            if ($null -ne $TestContract -and $null -ne $Contract.onStateWritten) {
                & $Contract.onStateWritten $State
            }
        } finally {
            if ($null -ne $stream) { $stream.Dispose() }
            if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
        }
    }
    $writeAdvancedStateIfValid = {
        param($Contract, $State)
        if (-not (& $isValidState $Contract $State $expectedCommit $pnpmExecutable $expectedPnpmSha256)) {
            return $false
        }
        & $writeState $Contract $State
        return $true
    }
    $moveDirectory = {
        param($Contract, [string] $Source, [string] $Destination)
        if ($null -ne $TestContract -and $null -ne $Contract.moveDirectory) {
            & $Contract.moveDirectory $Source $Destination
        } elseif ($null -ne $stableRenameSession) {
            if ([string]::Equals($Source, [string]$Contract.sourcePath, [StringComparison]::OrdinalIgnoreCase) -and
                [string]::Equals($Destination, [string]$Contract.destinationPath, [StringComparison]::OrdinalIgnoreCase)) {
                $stableRenameSession.MoveToDestination($null -ne $TestContract -and $Contract.failStableIdentityVerification -eq $true)
            } elseif ([string]::Equals($Source, [string]$Contract.destinationPath, [StringComparison]::OrdinalIgnoreCase) -and
                [string]::Equals($Destination, [string]$Contract.sourcePath, [StringComparison]::OrdinalIgnoreCase)) {
                $stableRenameSession.MoveToSource()
            } else {
                throw 'stable-rename-vector-invalid'
            }
        } else {
            [IO.Directory]::Move($Source, $Destination)
        }
    }
    $newMinimalEnvironment = {
        param($Contract, [string] $Executable, [string] $BoundPnpm)
        $environment = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
        $windowsRoot = [IO.Directory]::GetParent([Environment]::SystemDirectory).FullName
        $temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar)
        $localApplicationData = [IO.Path]::GetFullPath([string]$Contract.childLocalAppDataPath)
        $closedProfile = [IO.Path]::GetFullPath([string]$Contract.childProfilePath)
        $cmdExecutable = if ([string]::IsNullOrWhiteSpace([string]$Contract.cmdExecutable)) {
            Join-Path ([Environment]::SystemDirectory) 'cmd.exe'
        } else { [IO.Path]::GetFullPath([string]$Contract.cmdExecutable) }
        $pathEntries = [Collections.Generic.List[string]]::new()
        foreach ($candidate in @(
            [string]$Contract.nodeDirectory,
            [string]$Contract.gitDirectory,
            [Environment]::SystemDirectory,
            [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Executable)),
            [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($BoundPnpm)),
            (Join-Path ([string]$Contract.repositoryRoot) 'node_modules\.bin')
        )) {
            if ([string]::IsNullOrWhiteSpace($candidate) -or -not [IO.Directory]::Exists($candidate)) { continue }
            $canonical = [IO.Path]::GetFullPath($candidate)
            if (-not $pathEntries.Contains($canonical)) { $pathEntries.Add($canonical) }
        }
        $environment['SystemRoot'] = $windowsRoot
        $environment['WINDIR'] = $windowsRoot
        $environment['LOCALAPPDATA'] = $localApplicationData
        $environment['APPDATA'] = [IO.Path]::GetFullPath([string]$Contract.childRoamingAppDataPath)
        $environment['TEMP'] = $temporaryRoot
        $environment['TMP'] = $temporaryRoot
        $environment['HOME'] = $closedProfile
        $environment['USERPROFILE'] = $closedProfile
        $environment['PATH'] = [string]::Join(';', $pathEntries.ToArray())
        $environment['PATHEXT'] = '.COM;.EXE;.CMD'
        $environment['ComSpec'] = $cmdExecutable
        $environment['npm_config_script_shell'] = $cmdExecutable
        $environment['npm_config_userconfig'] = 'NUL'
        $environment['npm_config_globalconfig'] = 'NUL'
        $environment['NODE_OPTIONS'] = '--no-warnings'
        $environment['npm_config_node_options'] = '--no-warnings'
        $environment['NoDefaultCurrentDirectoryInExePath'] = '1'
        $environment['npm_execpath'] = [IO.Path]::GetFullPath($BoundPnpm)
        if (-not [string]::IsNullOrWhiteSpace([string]$Contract.nodeExecutable)) {
            $environment['NODE'] = [IO.Path]::GetFullPath([string]$Contract.nodeExecutable)
            $environment['npm_node_execpath'] = [IO.Path]::GetFullPath([string]$Contract.nodeExecutable)
        }
        if (-not [string]::IsNullOrWhiteSpace([string]$Contract.gitExecutable) -and
            -not [string]::IsNullOrWhiteSpace([string]$Contract.gitSha256)) {
            $environment['INTENTARC_PREFLIGHT_GIT_EXECUTABLE'] = [IO.Path]::GetFullPath([string]$Contract.gitExecutable)
            $environment['INTENTARC_PREFLIGHT_GIT_SHA256'] = [string]$Contract.gitSha256
        }
        return $environment
    }
    $getBoundFileRecord = {
        param([string] $Executable, [string] $ExpectedLeaf, [string] $ExpectedSha256)
        $path = [IO.Path]::GetFullPath($Executable)
        $item = & $getOrdinaryFile $path
        if ($null -eq $item -or
            -not [string]::Equals([IO.Path]::GetFileName($path), $ExpectedLeaf, [StringComparison]::OrdinalIgnoreCase)) {
            return $null
        }
        $attributes = [IO.File]::GetAttributes($path)
        $stableIdentity = & $getStableFileIdentity $contract $path
        if ([string]$stableIdentity -cnotmatch '^[a-f0-9]{8}:[a-f0-9]{16}$') { return $null }
        $stream = $null
        $sha = $null
        try {
            $stream = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
            $sha = [Security.Cryptography.SHA256]::Create()
            $digest = ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
        } finally {
            if ($null -ne $sha) { $sha.Dispose() }
            if ($null -ne $stream) { $stream.Dispose() }
        }
        $after = & $getOrdinaryFile $path
        if ($null -eq $after) { return $null }
        $record = [ordered]@{
            canonicalPath = [IO.Path]::GetFullPath($item.FullName)
            attributes = [int]$attributes
            length = [int64]$item.Length
            creationTimeUtc = $item.CreationTimeUtc.ToString('o')
            lastWriteTimeUtc = $item.LastWriteTimeUtc.ToString('o')
            stableIdentity = $stableIdentity
            sha256 = $digest
        }
        if (-not [string]::Equals([IO.Path]::GetFullPath($after.FullName), [string]$record.canonicalPath, [StringComparison]::OrdinalIgnoreCase) -or
            [int][IO.File]::GetAttributes($path) -ne [int]$record.attributes -or
            [int64]$after.Length -ne [int64]$record.length -or
            $after.CreationTimeUtc.ToString('o') -cne [string]$record.creationTimeUtc -or
            $after.LastWriteTimeUtc.ToString('o') -cne [string]$record.lastWriteTimeUtc -or
            [string](& $getStableFileIdentity $contract $path) -cne [string]$record.stableIdentity -or
            [string]$record.sha256 -cne $ExpectedSha256) {
            return $null
        }
        return $record
    }
    $getBoundGitRecord = {
        param($Contract)
        return & $getBoundFileRecord ([string]$Contract.gitExecutable) 'git.exe' ([string]$Contract.gitSha256)
    }
    $getBoundNodeRecord = {
        param($Contract)
        return & $getBoundFileRecord ([string]$Contract.nodeExecutable) 'node.exe' ([string]$Contract.nodeSha256)
    }
    $getBoundCmdRecord = {
        param($Contract)
        return & $getBoundFileRecord ([string]$Contract.cmdExecutable) 'cmd.exe' ([string]$Contract.cmdSha256)
    }
    $bindingRecordMatches = {
        param($Actual, $Expected)
        return $null -ne $Actual -and $null -ne $Expected -and
            [string]::Equals([string]$Actual.canonicalPath, [string]$Expected.canonicalPath, [StringComparison]::OrdinalIgnoreCase) -and
            [int]$Actual.attributes -eq [int]$Expected.attributes -and
            [int64]$Actual.length -eq [int64]$Expected.length -and
            [string]$Actual.creationTimeUtc -ceq [string]$Expected.creationTimeUtc -and
            [string]$Actual.lastWriteTimeUtc -ceq [string]$Expected.lastWriteTimeUtc -and
            [string]$Actual.stableIdentity -ceq [string]$Expected.stableIdentity -and
            [string]$Actual.sha256 -ceq [string]$Expected.sha256
    }
    $fixedRuntimeBindingsMatch = {
        param($Contract)
        $gitMatches = [string]::IsNullOrWhiteSpace([string]$Contract.gitExecutable) -or
            (& $bindingRecordMatches (& $getBoundGitRecord $Contract) $expectedGitBinding)
        $nodeMatches = [string]::IsNullOrWhiteSpace([string]$Contract.nodeExecutable) -or
            (& $bindingRecordMatches (& $getBoundNodeRecord $Contract) $expectedNodeBinding)
        $cmdMatches = [string]::IsNullOrWhiteSpace([string]$Contract.cmdExecutable) -or
            (& $bindingRecordMatches (& $getBoundCmdRecord $Contract) $expectedCmdBinding)
        return $gitMatches -and $nodeMatches -and $cmdMatches
    }
    $invokeBoundGit = {
        param($Contract, [string[]] $GitArguments)
        $before = & $getBoundGitRecord $Contract
        if (-not (& $bindingRecordMatches $before $expectedGitBinding)) { throw 'repository-state-invalid' }
        $environment = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
        $windowsRoot = [IO.Directory]::GetParent([Environment]::SystemDirectory).FullName
        $temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar)
        $environment['SystemRoot'] = $windowsRoot
        $environment['WINDIR'] = $windowsRoot
        $environment['TEMP'] = $temporaryRoot
        $environment['TMP'] = $temporaryRoot
        $environment['GIT_CONFIG_NOSYSTEM'] = '1'
        $environment['GIT_CONFIG_GLOBAL'] = 'NUL'
        Initialize-IntentArcPreflightNativeProcessType
        $arguments = @('--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false', '-C', [string]$Contract.repositoryRoot) + @($GitArguments)
        $standardOutput = [IntentArc.Preflight.NativeProcess]::RunForStandardOutput(
            [string]$Contract.gitExecutable,
            [string[]]$arguments,
            [string]$Contract.repositoryRoot,
            $environment,
            30000,
            1000,
            65536,
            ([string]$Contract.jobName + '.git')
        )
        $after = & $getBoundGitRecord $Contract
        if ($null -eq $after -or
            [string]$after.sha256 -cne [string]$before.sha256 -or
            [string]$after.creationTimeUtc -cne [string]$before.creationTimeUtc -or
            [string]$after.lastWriteTimeUtc -cne [string]$before.lastWriteTimeUtc -or
            -not (& $bindingRecordMatches $after $expectedGitBinding)) {
            throw 'repository-state-invalid'
        }
        return [string]$standardOutput
    }
    $invokeChild = {
        param($Contract, [string] $Executable)
        $argumentList = @(
            '--dir', [string]$Contract.repositoryRoot,
            'run', 'desktop:release:preflight',
            '--run-id', [string]$Contract.runId,
            '--tracked-only'
        )
        if ($null -ne $TestContract -and $null -ne $Contract.invokeChild) {
            return & $Contract.invokeChild $Executable $argumentList ([string]$Contract.repositoryRoot) ([int]$Contract.timeoutMilliseconds)
        }
        $nativeExecutable = $Executable
        $nativeArguments = $argumentList
        $descendantGrace = 2000
        if ($null -ne $TestContract -and $Contract.useNativeChild -eq $true) {
            $nativeExecutable = [IO.Path]::GetFullPath([string]$Contract.nativeChildExecutable)
            $nativeArguments = @($Contract.nativeChildArguments | ForEach-Object { [string]$_ })
            $descendantGrace = [int]$Contract.nativeChildGraceMilliseconds
        }
        Initialize-IntentArcPreflightNativeProcessType
        $environment = & $newMinimalEnvironment $Contract $nativeExecutable $Executable
        $gitLock = $null
        $nodeLock = $null
        $cmdLock = $null
        $pnpmLock = $null
        $childGitBindingValid = $true
        $childNodeBindingValid = $true
        $childCmdBindingValid = $true
        $childPnpmBindingValid = $true
        try {
            if (-not (& $pnpmBindingMatches $Contract $Executable $expectedPnpmBinding ([string]$expectedPnpmBinding.sha256))) {
                throw 'child-pnpm-binding-invalid'
            }
            $pnpmLock = [IO.File]::Open(
                $Executable,
                [IO.FileMode]::Open,
                [IO.FileAccess]::Read,
                [IO.FileShare]::Read
            )
            if (-not [string]::IsNullOrWhiteSpace([string]$Contract.gitExecutable)) {
                if ($null -eq (& $getBoundGitRecord $Contract)) { throw 'child-git-binding-invalid' }
                $gitLock = [IO.File]::Open(
                    [string]$Contract.gitExecutable,
                    [IO.FileMode]::Open,
                    [IO.FileAccess]::Read,
                    [IO.FileShare]::Read
                )
            }
            if (-not [string]::IsNullOrWhiteSpace([string]$Contract.nodeExecutable)) {
                if ($null -eq (& $getBoundNodeRecord $Contract)) { throw 'child-node-binding-invalid' }
                $nodeLock = [IO.File]::Open(
                    [string]$Contract.nodeExecutable,
                    [IO.FileMode]::Open,
                    [IO.FileAccess]::Read,
                    [IO.FileShare]::Read
                )
            }
            if (-not [string]::IsNullOrWhiteSpace([string]$Contract.cmdExecutable)) {
                if ($null -eq (& $getBoundCmdRecord $Contract)) { throw 'child-cmd-binding-invalid' }
                $cmdLock = [IO.File]::Open(
                    [string]$Contract.cmdExecutable,
                    [IO.FileMode]::Open,
                    [IO.FileAccess]::Read,
                    [IO.FileShare]::Read
                )
            }
            if (-not (& $pnpmBindingMatches $Contract $Executable $expectedPnpmBinding ([string]$expectedPnpmBinding.sha256))) {
                throw 'child-pnpm-binding-invalid'
            }
            if ($null -ne $gitLock -and -not (& $bindingRecordMatches (& $getBoundGitRecord $Contract) $expectedGitBinding)) {
                throw 'child-git-binding-invalid'
            }
            if ($null -ne $nodeLock -and -not (& $bindingRecordMatches (& $getBoundNodeRecord $Contract) $expectedNodeBinding)) {
                throw 'child-node-binding-invalid'
            }
            if ($null -ne $cmdLock -and -not (& $bindingRecordMatches (& $getBoundCmdRecord $Contract) $expectedCmdBinding)) {
                throw 'child-cmd-binding-invalid'
            }
            if ($null -ne $TestContract -and -not [string]::IsNullOrWhiteSpace([string]$Contract.nativeFault)) {
                $native = [IntentArc.Preflight.NativeProcess]::RunForTest(
                    $nativeExecutable,
                    [string[]]$nativeArguments,
                    [string]$Contract.repositoryRoot,
                    $environment,
                    [int]$Contract.timeoutMilliseconds,
                    $descendantGrace,
                    [int]$Contract.maximumBytesPerStream,
                    [string]$Contract.jobName,
                    [string]$Contract.nativeFault
                )
            } else {
                $native = [IntentArc.Preflight.NativeProcess]::Run(
                    $nativeExecutable,
                    [string[]]$nativeArguments,
                    [string]$Contract.repositoryRoot,
                    $environment,
                    [int]$Contract.timeoutMilliseconds,
                    $descendantGrace,
                    [int]$Contract.maximumBytesPerStream,
                    [string]$Contract.jobName
                )
            }
            if ($null -ne $gitLock -and $null -eq (& $getBoundGitRecord $Contract)) { $childGitBindingValid = $false }
            if ($null -ne $nodeLock -and $null -eq (& $getBoundNodeRecord $Contract)) { $childNodeBindingValid = $false }
            if ($null -ne $cmdLock -and $null -eq (& $getBoundCmdRecord $Contract)) { $childCmdBindingValid = $false }
            if ($null -ne $pnpmLock -and -not (& $pnpmBindingMatches $Contract $Executable $expectedPnpmBinding ([string]$expectedPnpmBinding.sha256))) {
                $childPnpmBindingValid = $false
            }
        } finally {
            if ($null -ne $pnpmLock) { $pnpmLock.Dispose() }
            if ($null -ne $cmdLock) { $cmdLock.Dispose() }
            if ($null -ne $nodeLock) { $nodeLock.Dispose() }
            if ($null -ne $gitLock) { $gitLock.Dispose() }
        }
        $native.InfrastructureFailure = $native.InfrastructureFailure -or
            -not $childGitBindingValid -or -not $childNodeBindingValid -or
            -not $childCmdBindingValid -or -not $childPnpmBindingValid
        return $native
    }
    $getKeys = {
        param($Value)
        if ($null -eq $Value) { return @() }
        if ($Value -is [Collections.IDictionary]) { return @($Value.Keys) }
        return @($Value.PSObject.Properties.Name)
    }
    $isStateObject = {
        param($Value)
        return $Value -is [Collections.IDictionary] -or $Value -is [PSCustomObject]
    }
    $hasExactKeys = {
        param($Value, [string[]] $Expected)
        if (-not (& $isStateObject $Value)) { return $false }
        $actual = @(& $getKeys $Value)
        if ($actual.Count -ne $Expected.Count) { return $false }
        foreach ($key in $actual) {
            if ($Expected -cnotcontains [string]$key) { return $false }
        }
        return $true
    }
    $isTimestampOrNull = {
        param($Value)
        if ($null -eq $Value) { return $true }
        if ($Value -isnot [string] -or $Value.Length -gt 40) { return $false }
        $parsed = [DateTime]::MinValue
        return [DateTime]::TryParseExact(
            $Value,
            'o',
            [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::RoundtripKind,
            [ref]$parsed
        )
    }
    $isSafeCounter = {
        param($Value)
        return ($Value -is [int] -or $Value -is [long]) -and
            [int64]$Value -ge 0 -and
            [int64]$Value -le 9007199254740991
    }
    $isSafePid = {
        param($Value)
        return $null -eq $Value -or ($Value -is [int] -and $Value -ge 1 -and $Value -le 2147483647)
    }
    $projectChildEvidence = {
        param($NativeResult)
        $descendantsSettled = $NativeResult.DescendantsSettled -eq $true
        $outputOverflow = $NativeResult.OutputOverflow -eq $true
        $timedOut = $NativeResult.TimedOut -eq $true
        $canceled = $NativeResult.Canceled -eq $true
        $infrastructureFailure = $NativeResult.InfrastructureFailure -eq $true -or -not $descendantsSettled
        $rootProcessId = if ($null -eq $NativeResult.RootProcessId) { $null } else { [int]$NativeResult.RootProcessId }
        $rootStartTimeUtc = if ($null -eq $NativeResult.RootStartTimeUtc) { $null } else { [string]$NativeResult.RootStartTimeUtc }
        $stdoutBytes = if ($null -ne $NativeResult.StandardOutputBytes) { [int64]$NativeResult.StandardOutputBytes } else { [int64]$NativeResult.stdoutBytes }
        $stderrBytes = if ($null -ne $NativeResult.StandardErrorBytes) { [int64]$NativeResult.StandardErrorBytes } else { [int64]$NativeResult.stderrBytes }
        $identityObserved = $rootProcessId -is [int] -and $rootProcessId -gt 0 -and
            $rootStartTimeUtc -is [string] -and (& $isTimestampOrNull $rootStartTimeUtc)
        $terminationReason = if (-not $descendantsSettled) {
            'settlement-failed'
        } elseif ($outputOverflow) {
            'output-overflow'
        } elseif ($timedOut) {
            'timeout'
        } elseif ($canceled) {
            'canceled'
        } elseif ($infrastructureFailure) {
            'infrastructure-failure'
        } else {
            'normal-exit'
        }
        if ($terminationReason -cne 'settlement-failed') {
            $outputOverflow = $terminationReason -ceq 'output-overflow'
            $timedOut = $terminationReason -ceq 'timeout'
            $canceled = $terminationReason -ceq 'canceled'
            $infrastructureFailure = $terminationReason -ceq 'infrastructure-failure'
        }
        $exitCode = if ($null -eq $NativeResult.ExitCode) { $null } else { [int]$NativeResult.ExitCode }
        if (@('output-overflow', 'timeout', 'canceled') -ccontains $terminationReason) { $exitCode = $null }
        return [ordered]@{
            jobName = [string]$NativeResult.JobName
            rootProcessId = $rootProcessId
            rootStartTimeUtc = $rootStartTimeUtc
            assignmentStatus = if ($identityObserved) { 'assigned' } else { 'attempted' }
            settlementStatus = if ($descendantsSettled) { 'settled' } else { 'unsettled' }
            terminationReason = $terminationReason
            exitCode = $exitCode
            stdoutBytes = $stdoutBytes
            stderrBytes = $stderrBytes
            outputOverflow = $outputOverflow
            timedOut = $timedOut
            canceled = $canceled
            infrastructureFailure = $infrastructureFailure
        }
    }
    $isValidOwnedRoot = {
        param($Value, $ExpectedPath)
        try {
            if (-not (& $isStateObject $Value) -or
                -not (& $hasExactKeys $Value @('canonicalPath', 'attributes', 'stableIdentity')) -or
                $Value.canonicalPath -isnot [string] -or
                -not [string]::Equals(
                    [string]$Value.canonicalPath,
                    [IO.Path]::GetFullPath([string]$ExpectedPath),
                    [StringComparison]::OrdinalIgnoreCase
                ) -or
                $Value.attributes -isnot [int] -or
                (([int]$Value.attributes -band [int][IO.FileAttributes]::Directory) -eq 0) -or
                (([int]$Value.attributes -band [int][IO.FileAttributes]::ReparsePoint) -ne 0) -or
                $Value.stableIdentity -isnot [string] -or
                $Value.stableIdentity -cnotmatch '^[a-f0-9]{8}:[a-f0-9]{16}$') {
                return $false
            }
            return $true
        } catch { return $false }
    }
    $isValidRecovery = {
        param($Recovery, $Phase)
        try {
            if (-not (& $isStateObject $Recovery) -or
                -not (& $hasExactKeys $Recovery @('mode', 'sourcePhase', 'settlementProvenAt')) -or
                $Recovery.mode -isnot [string] -or
                @('none', 'restore-only') -cnotcontains [string]$Recovery.mode -or
                ($null -ne $Recovery.sourcePhase -and $Recovery.sourcePhase -isnot [string]) -or
                ($null -ne $Recovery.settlementProvenAt -and -not (& $isTimestampOrNull $Recovery.settlementProvenAt))) {
                return $false
            }
            if ([string]$Recovery.mode -ceq 'none') {
                return $null -eq $Recovery.sourcePhase -and $null -eq $Recovery.settlementProvenAt
            }
            if (@('prepared', 'preserved', 'child-started', 'child-settled') -cnotcontains [string]$Recovery.sourcePhase -or
                $null -eq $Recovery.settlementProvenAt) {
                return $false
            }
            return [string]$Phase -ceq [string]$Recovery.sourcePhase -or
                @('restored', 'complete') -ccontains [string]$Phase
        } catch { return $false }
    }
    $isValidChildTuple = {
        param($Child, $Phase, $Recovery)
        try {
            $childKeys = @(
                'jobName', 'rootProcessId', 'rootStartTimeUtc', 'assignmentStatus', 'settlementStatus',
                'terminationReason', 'exitCode', 'stdoutBytes', 'stderrBytes', 'outputOverflow', 'timedOut',
                'canceled', 'infrastructureFailure'
            )
            if (-not (& $isStateObject $Child) -or
                -not (& $hasExactKeys $Child $childKeys) -or
                $Child.jobName -isnot [string] -or
                [string]$Child.jobName -cne [string]$contract.jobName -or
                -not (& $isSafePid $Child.rootProcessId) -or
                -not (& $isTimestampOrNull $Child.rootStartTimeUtc) -or
                ($null -ne $Child.rootStartTimeUtc -and $Child.rootStartTimeUtc -isnot [string]) -or
                $Child.assignmentStatus -isnot [string] -or
                @('not-attempted', 'attempted', 'assigned', 'unknown') -cnotcontains [string]$Child.assignmentStatus -or
                $Child.settlementStatus -isnot [string] -or
                @('not-started', 'unsettled', 'settled') -cnotcontains [string]$Child.settlementStatus -or
                $Child.terminationReason -isnot [string] -or
                @('not-started', 'normal-exit', 'output-overflow', 'timeout', 'canceled', 'infrastructure-failure', 'settlement-failed', 'unknown') -cnotcontains [string]$Child.terminationReason -or
                ($null -ne $Child.exitCode -and $Child.exitCode -isnot [int]) -or
                -not (& $isSafeCounter $Child.stdoutBytes) -or
                -not (& $isSafeCounter $Child.stderrBytes)) {
                return $false
            }
            foreach ($flagName in @('outputOverflow', 'timedOut', 'canceled', 'infrastructureFailure')) {
                if ($Child.$flagName -isnot [bool]) { return $false }
            }
            $hasRootPid = $null -ne $Child.rootProcessId
            $hasRootStart = $null -ne $Child.rootStartTimeUtc
            if ($hasRootPid -ne $hasRootStart) { return $false }

            $effectivePhase = [string]$Phase
            if ([string]$Recovery.mode -ceq 'restore-only') {
                $effectivePhase = [string]$Recovery.sourcePhase
            } elseif (@('restored', 'complete') -ccontains [string]$Phase) {
                $effectivePhase = 'child-settled'
            }
            $assignment = [string]$Child.assignmentStatus
            $settlement = [string]$Child.settlementStatus
            $termination = [string]$Child.terminationReason
            $identityAbsent = -not $hasRootPid
            $identityPresent = $hasRootPid
            $allFlagsFalse = -not $Child.outputOverflow -and -not $Child.timedOut -and
                -not $Child.canceled -and -not $Child.infrastructureFailure
            $isValid = $false

            if (@('prepared', 'preserved') -ccontains $effectivePhase) {
                $isValid = $assignment -ceq 'not-attempted' -and $settlement -ceq 'not-started' -and
                    $identityAbsent -and $termination -ceq 'not-started' -and $null -eq $Child.exitCode -and
                    [int64]$Child.stdoutBytes -eq 0 -and [int64]$Child.stderrBytes -eq 0 -and $allFlagsFalse
            } elseif ($effectivePhase -ceq 'child-started') {
                $isValid = $assignment -ceq 'attempted' -and $settlement -ceq 'unsettled' -and
                    $identityAbsent -and $termination -ceq 'unknown' -and $null -eq $Child.exitCode -and
                    [int64]$Child.stdoutBytes -eq 0 -and [int64]$Child.stderrBytes -eq 0 -and $allFlagsFalse
            } elseif ($effectivePhase -ceq 'child-settled') {
                switch ($termination) {
                    'normal-exit' {
                        $isValid = $assignment -ceq 'assigned' -and $settlement -ceq 'settled' -and
                            $identityPresent -and $Child.exitCode -is [int] -and $allFlagsFalse
                    }
                    'output-overflow' {
                        $isValid = $assignment -ceq 'assigned' -and $settlement -ceq 'settled' -and
                            $identityPresent -and $null -eq $Child.exitCode -and
                            ([int64]$Child.stdoutBytes -gt 1048576 -or [int64]$Child.stderrBytes -gt 1048576) -and
                            $Child.outputOverflow -and -not $Child.timedOut -and -not $Child.canceled -and -not $Child.infrastructureFailure
                    }
                    'timeout' {
                        $isValid = $assignment -ceq 'assigned' -and $settlement -ceq 'settled' -and
                            $identityPresent -and $null -eq $Child.exitCode -and
                            -not $Child.outputOverflow -and $Child.timedOut -and -not $Child.canceled -and -not $Child.infrastructureFailure
                    }
                    'canceled' {
                        $assignmentValid = ($assignment -ceq 'attempted' -and $identityAbsent) -or
                            ($assignment -ceq 'assigned' -and $identityPresent)
                        $isValid = $assignmentValid -and $settlement -ceq 'settled' -and $null -eq $Child.exitCode -and
                            -not $Child.outputOverflow -and -not $Child.timedOut -and $Child.canceled -and -not $Child.infrastructureFailure
                    }
                    'infrastructure-failure' {
                        $assignmentValid = ($assignment -ceq 'attempted' -and $identityAbsent) -or
                            ($assignment -ceq 'assigned' -and $identityPresent)
                        $exitValid = $null -eq $Child.exitCode -or ($assignment -ceq 'assigned' -and $Child.exitCode -is [int])
                        $isValid = $assignmentValid -and $settlement -ceq 'settled' -and $exitValid -and
                            -not $Child.outputOverflow -and -not $Child.timedOut -and -not $Child.canceled -and $Child.infrastructureFailure
                    }
                    'settlement-failed' {
                        $assignmentValid = ($assignment -ceq 'attempted' -and $identityAbsent) -or
                            ($assignment -ceq 'assigned' -and $identityPresent) -or
                            ($assignment -ceq 'unknown' -and ($identityAbsent -or $identityPresent))
                        $isValid = $assignmentValid -and $settlement -ceq 'unsettled' -and
                            ($null -eq $Child.exitCode -or $Child.exitCode -is [int]) -and $Child.infrastructureFailure
                    }
                }
            }
            if (-not $isValid) { return $false }
            $Child.stdoutBytes = [int64]$Child.stdoutBytes
            $Child.stderrBytes = [int64]$Child.stderrBytes
            return $true
        } catch { return $false }
    }
    $isValidCleanup = {
        param($Cleanup, $Phase)
        try {
            if (-not (& $isStateObject $Cleanup) -or
                -not (& $hasExactKeys $Cleanup @('localAppDataStatus', 'profileStatus', 'runRootStatus', 'category'))) {
                return $false
            }
            foreach ($statusName in @('localAppDataStatus', 'profileStatus', 'runRootStatus')) {
                if ($Cleanup.$statusName -isnot [string] -or
                    @('pending', 'removed', 'retained', 'invalid') -cnotcontains [string]$Cleanup.$statusName) {
                    return $false
                }
            }
            if ($Cleanup.category -isnot [string] -or @('none', 'residue-invalid') -cnotcontains [string]$Cleanup.category) {
                return $false
            }
            if ([string]$Phase -cne 'complete') {
                return [string]$Cleanup.localAppDataStatus -ceq 'pending' -and
                    [string]$Cleanup.profileStatus -ceq 'pending' -and
                    [string]$Cleanup.runRootStatus -ceq 'pending' -and
                    [string]$Cleanup.category -ceq 'none'
            }
            if (@(
                [string]$Cleanup.localAppDataStatus,
                [string]$Cleanup.profileStatus,
                [string]$Cleanup.runRootStatus
            ) -ccontains 'pending') { return $false }
            $allRemoved = [string]$Cleanup.localAppDataStatus -ceq 'removed' -and
                [string]$Cleanup.profileStatus -ceq 'removed' -and
                [string]$Cleanup.runRootStatus -ceq 'removed'
            if ([string]$Cleanup.runRootStatus -ceq 'removed' -and
                ([string]$Cleanup.localAppDataStatus -cne 'removed' -or [string]$Cleanup.profileStatus -cne 'removed')) {
                return $false
            }
            return ($allRemoved -and [string]$Cleanup.category -ceq 'none') -or
                (-not $allRemoved -and [string]$Cleanup.category -ceq 'residue-invalid')
        } catch { return $false }
    }
    $isValidTimestamps = {
        param($Timestamps, $Phase, $Recovery)
        try {
            $timestampNames = @('preparedAt', 'preservedAt', 'childStartedAt', 'childSettledAt', 'restoredAt', 'completedAt')
            if (-not (& $isStateObject $Timestamps) -or -not (& $hasExactKeys $Timestamps $timestampNames)) {
                return $false
            }
            foreach ($name in $timestampNames) {
                if (-not (& $isTimestampOrNull $Timestamps.$name)) { return $false }
            }
            $originalPhase = [string]$Phase
            if ([string]$Recovery.mode -ceq 'restore-only') { $originalPhase = [string]$Recovery.sourcePhase }
            $phaseTimestampMatrix = @{
                prepared = @($true, $false, $false, $false)
                preserved = @($true, $true, $false, $false)
                'child-started' = @($true, $true, $true, $false)
                'child-settled' = @($true, $true, $true, $true)
                restored = @($true, $true, $true, $true)
                complete = @($true, $true, $true, $true)
            }
            $requirements = @($phaseTimestampMatrix[$originalPhase])
            if ($requirements.Count -ne 4) { return $false }
            for ($index = 0; $index -lt 4; $index++) {
                $value = $Timestamps.($timestampNames[$index])
                if ($requirements[$index] -eq $true -and $null -eq $value) { return $false }
                if ($requirements[$index] -eq $false -and $null -ne $value) { return $false }
            }
            $restoredRequired = [string]$Phase -ceq 'restored' -or [string]$Phase -ceq 'complete'
            $completedRequired = [string]$Phase -ceq 'complete'
            if ($restoredRequired -ne ($null -ne $Timestamps.restoredAt) -or
                $completedRequired -ne ($null -ne $Timestamps.completedAt)) {
                return $false
            }

            $lastTimestamp = [DateTime]::MinValue
            $lastOriginalTimestamp = [DateTime]::MinValue
            for ($index = 0; $index -lt $timestampNames.Count; $index++) {
                $value = $Timestamps.($timestampNames[$index])
                if ($null -eq $value) { continue }
                $parsedTimestamp = [DateTime]::ParseExact(
                    [string]$value,
                    'o',
                    [Globalization.CultureInfo]::InvariantCulture,
                    [Globalization.DateTimeStyles]::RoundtripKind
                ).ToUniversalTime()
                if ($parsedTimestamp -lt $lastTimestamp) { return $false }
                $lastTimestamp = $parsedTimestamp
                if ($index -lt 4) { $lastOriginalTimestamp = $parsedTimestamp }
            }
            if ([string]$Recovery.mode -ceq 'restore-only') {
                $settlementProof = [DateTime]::ParseExact(
                    [string]$Recovery.settlementProvenAt,
                    'o',
                    [Globalization.CultureInfo]::InvariantCulture,
                    [Globalization.DateTimeStyles]::RoundtripKind
                ).ToUniversalTime()
                if ($settlementProof -lt $lastOriginalTimestamp) { return $false }
                if ($null -ne $Timestamps.restoredAt) {
                    $restoredAt = [DateTime]::ParseExact([string]$Timestamps.restoredAt, 'o', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
                    if ($restoredAt -lt $settlementProof) { return $false }
                }
            }
            return $true
        } catch { return $false }
    }
    $isValidState = {
        param($Contract, $State, [string] $ExpectedCommit, [string] $PnpmPath, [string] $PnpmSha256)
        try {
            if (-not (& $hasExactKeys $State @(
                'schema', 'sourcePath', 'destinationPath', 'runId', 'expectedCommit',
                'directory', 'ownedRoots', 'pnpm', 'child', 'recovery', 'cleanup', 'timestamps', 'phase'
            )) -or
                $State.schema -isnot [string] -or
                $State.schema -cne 'intentarc.preflight-out-preservation-state/v2' -or
                $State.sourcePath -isnot [string] -or
                -not [string]::Equals([string]$State.sourcePath, [string]$Contract.sourcePath, [StringComparison]::OrdinalIgnoreCase) -or
                $State.destinationPath -isnot [string] -or
                -not [string]::Equals([string]$State.destinationPath, [string]$Contract.destinationPath, [StringComparison]::OrdinalIgnoreCase) -or
                $State.runId -isnot [string] -or
                [string]$State.runId -cne [string]$Contract.runId -or
                $State.expectedCommit -isnot [string] -or
                $State.expectedCommit -cnotmatch '^[a-f0-9]{40}$' -or
                [string]$State.expectedCommit -cne $ExpectedCommit -or
                $State.phase -isnot [string] -or
                @('prepared', 'preserved', 'child-started', 'child-settled', 'restored', 'complete') -cnotcontains [string]$State.phase) {
                return $false
            }
            if (-not (& $hasExactKeys $State.directory @('canonicalPath', 'attributes', 'creationTimeUtc', 'lastWriteTimeUtc', 'stableIdentity')) -or
                $State.directory.canonicalPath -isnot [string] -or
                -not [string]::Equals([string]$State.directory.canonicalPath, [IO.Path]::GetFullPath([string]$Contract.sourcePath), [StringComparison]::OrdinalIgnoreCase) -or
                $State.directory.attributes -isnot [int] -or
                (([int]$State.directory.attributes -band [int][IO.FileAttributes]::Directory) -eq 0) -or
                (([int]$State.directory.attributes -band [int][IO.FileAttributes]::ReparsePoint) -ne 0) -or
                -not (& $isTimestampOrNull $State.directory.creationTimeUtc) -or $null -eq $State.directory.creationTimeUtc -or
                -not (& $isTimestampOrNull $State.directory.lastWriteTimeUtc) -or $null -eq $State.directory.lastWriteTimeUtc -or
                $State.directory.stableIdentity -isnot [string] -or
                [string]$State.directory.stableIdentity -cnotmatch '^[a-f0-9]{8}:[a-f0-9]{16}$') {
                return $false
            }
            if (-not (& $hasExactKeys $State.ownedRoots @('profile', 'localAppData')) -or
                -not (& $isValidOwnedRoot $State.ownedRoots.profile ([string]$Contract.childProfilePath)) -or
                -not (& $isValidOwnedRoot $State.ownedRoots.localAppData ([string]$Contract.childLocalAppDataPath))) {
                return $false
            }
            if (-not (& $hasExactKeys $State.pnpm @('path', 'sha256')) -or
                $State.pnpm.path -isnot [string] -or
                -not [string]::Equals([string]$State.pnpm.path, $PnpmPath, [StringComparison]::OrdinalIgnoreCase) -or
                $State.pnpm.sha256 -isnot [string] -or
                $State.pnpm.sha256 -cnotmatch '^[a-f0-9]{64}$' -or
                [string]$State.pnpm.sha256 -cne $PnpmSha256) {
                return $false
            }
            if (-not (& $isValidRecovery $State.recovery ([string]$State.phase)) -or
                -not (& $isValidChildTuple $State.child ([string]$State.phase) $State.recovery) -or
                -not (& $isValidCleanup $State.cleanup ([string]$State.phase)) -or
                -not (& $isValidTimestamps $State.timestamps ([string]$State.phase) $State.recovery)) {
                return $false
            }
            return $true
        } catch { return $false }
    }
    $isValidIdentityReceipt = {
        param($Identity)
        return (& $hasExactKeys $Identity @('before', 'after', 'unchanged')) -and
            $Identity.before -is [string] -and $Identity.before -cmatch '^[a-f0-9]{64}$' -and
            $Identity.after -is [string] -and $Identity.after -ceq $Identity.before -and
            $Identity.unchanged -is [bool] -and $Identity.unchanged -eq $true
    }
    $isValidReceipt = {
        param($Contract)
        try {
            if ($null -eq (& $getOrdinaryFile ([string]$Contract.receiptPath))) { return $false }
            $receipt = & $readLockedJson $Contract ([string]$Contract.receiptPath) 'beforeReceiptRead' 262144
            if (-not (& $hasExactKeys $receipt @(
                'schemaVersion', 'runId', 'status', 'failureCategory', 'checks',
                'git', 'source', 'packageJson', 'vendor', 'out'
            )) -or
                $receipt.schemaVersion -isnot [int] -or $receipt.schemaVersion -ne 2 -or
                [string]$receipt.runId -cne [string]$Contract.runId -or
                [string]$receipt.status -cne 'passed' -or
                $null -ne $receipt.failureCategory) {
                return $false
            }
            $checkIds = @('focused-tests', 'server-typecheck', 'web-typecheck', 'adapter-strict')
            if (-not (& $hasExactKeys $receipt.checks $checkIds)) { return $false }
            foreach ($checkId in $checkIds) {
                if ([string]$receipt.checks.$checkId -cne 'passed') { return $false }
            }
            if (-not (& $hasExactKeys $receipt.git @(
                'statusScope', 'diffCheckPassed', 'productDiffClean', 'statusClean', 'statusEntryCount'
            )) -or
                [string]$receipt.git.statusScope -cne 'tracked-only' -or
                $receipt.git.diffCheckPassed -isnot [bool] -or $receipt.git.diffCheckPassed -ne $true -or
                $receipt.git.productDiffClean -isnot [bool] -or $receipt.git.productDiffClean -ne $true -or
                $receipt.git.statusClean -isnot [bool] -or $receipt.git.statusClean -ne $true -or
                $receipt.git.statusEntryCount -isnot [int] -or $receipt.git.statusEntryCount -ne 0) {
                return $false
            }
            if (-not (& $isValidIdentityReceipt $receipt.source) -or
                -not (& $isValidIdentityReceipt $receipt.packageJson) -or
                -not (& $isValidIdentityReceipt $receipt.vendor)) {
                return $false
            }
            if (-not (& $hasExactKeys $receipt.out @('absentBefore', 'absentAfter')) -or
                $receipt.out.absentBefore -isnot [bool] -or $receipt.out.absentBefore -ne $true -or
                $receipt.out.absentAfter -isnot [bool] -or $receipt.out.absentAfter -ne $true) {
                return $false
            }
            return $true
        } catch { return $false }
    }

    if ($ArgumentsVector.Count -ne 7 -or
        @('-Execute', '-RestoreOnly') -cnotcontains [string]$ArgumentsVector[0] -or
        $ArgumentsVector[1] -cne '-ExpectedCommit' -or
        $ArgumentsVector[3] -cne '-PnpmExecutable' -or
        $ArgumentsVector[5] -cne '-ExpectedPnpmSha256') {
        return & $refuse 'arguments-invalid'
    }
    $mode = [string]$ArgumentsVector[0]
    $expectedCommit = $ArgumentsVector[2]
    $pnpmExecutable = $ArgumentsVector[4]
    $expectedPnpmSha256 = $ArgumentsVector[6]
    if ($expectedCommit -isnot [string] -or $expectedCommit -cnotmatch '^[a-f0-9]{40}$' -or
        $expectedPnpmSha256 -isnot [string] -or $expectedPnpmSha256 -cnotmatch '^[a-f0-9]{64}$' -or
        (& $isUnsafeText $pnpmExecutable) -or
        -not (& $isFullyQualifiedLocalWindowsPath ([string]$pnpmExecutable)) -or
        -not [string]::Equals([IO.Path]::GetFileName([string]$pnpmExecutable), 'pnpm.exe', [StringComparison]::OrdinalIgnoreCase)) {
        return & $refuse 'arguments-invalid'
    }
    $preparedWriteAttempted = $false
    $preparedStateDurable = $false
    try {
        $pnpmExecutable = [IO.Path]::GetFullPath([string]$pnpmExecutable)
    } catch {
        return & $refuse 'arguments-invalid'
    }

    $contract = if ($null -eq $TestContract) {
        New-IntentArcPreflightOutPreservationProductionContract
    } else {
        $TestContract
    }
    try {
        $expectedPreservationParent = [IO.Path]::GetFullPath((Join-Path ([string]$contract.superpowersPath) 'preflight-out-preservation'))
        $expectedRunRoot = [IO.Path]::GetFullPath((Join-Path $expectedPreservationParent ([string]$contract.runId)))
        $expectedChildProfilePath = [IO.Path]::GetFullPath((Join-Path $expectedRunRoot 'profile'))
        $expectedChildLocalAppDataPath = [IO.Path]::GetFullPath((Join-Path $expectedRunRoot 'localappdata'))
        $expectedChildRoamingAppDataPath = [IO.Path]::GetFullPath((Join-Path $expectedChildLocalAppDataPath 'Roaming'))
        if (-not [string]::Equals(
            [IO.Path]::GetFullPath([string]$contract.preservationParent),
            $expectedPreservationParent,
            [StringComparison]::OrdinalIgnoreCase
        ) -or -not [string]::Equals(
            [IO.Path]::GetFullPath([string]$contract.runRoot),
            $expectedRunRoot,
            [StringComparison]::OrdinalIgnoreCase
        ) -or -not [string]::Equals(
            [IO.Path]::GetFullPath([string]$contract.childProfilePath),
            $expectedChildProfilePath,
            [StringComparison]::OrdinalIgnoreCase
        ) -or -not [string]::Equals(
            [IO.Path]::GetFullPath([string]$contract.childLocalAppDataPath),
            $expectedChildLocalAppDataPath,
            [StringComparison]::OrdinalIgnoreCase
        ) -or -not [string]::Equals(
            [IO.Path]::GetFullPath([string]$contract.childRoamingAppDataPath),
            $expectedChildRoamingAppDataPath,
            [StringComparison]::OrdinalIgnoreCase
        )) { return & $refuse 'preservation-state-invalid' }
    } catch { return & $refuse 'preservation-state-invalid' }
    $stableRenameSession = $null
    $receiptBoundaryGuard = $null
    $profileGuard = $null
    $profileIdentity = $null
    $localAppDataGuard = $null
    $localAppDataIdentity = $null
    $superpowersSetupGuard = $null
    $preservationParentSetupGuard = $null
    $runRootSetupGuard = $null
    $roamingSetupGuard = $null
    $runRootCleanupIdentity = $null
    $useProductionStateSecurity = $null -eq $TestContract -or $contract.useProductionStateSecurity -eq $true
    $expectedGitBinding = $null
    $expectedNodeBinding = $null
    $expectedCmdBinding = $null
    $expectedPnpmBinding = $null
    if ($mode -ceq '-Execute' -and
        ($null -eq (& $getOrdinaryDirectoryIdentity ([string]$contract.repositoryRoot)) -or
         $null -eq (& $getOrdinaryDirectoryIdentity ([string]$contract.superpowersPath)))) {
        return & $refuse 'repository-invalid'
    }
    $parentState = & $probeExactEntry ([string]$contract.preservationParent)
    if ($parentState -ceq 'present' -and $null -eq (& $getOrdinaryDirectoryIdentity ([string]$contract.preservationParent))) {
        return & $refuse 'preservation-state-invalid'
    }
    if ($parentState -cne 'present' -and $parentState -cne 'absent') {
        return & $refuse 'preservation-state-invalid'
    }
    if ($mode -ceq '-Execute') {
        $expectedGitBinding = if ([string]::IsNullOrWhiteSpace([string]$contract.gitExecutable)) { $null } else { & $getBoundGitRecord $contract }
        $expectedNodeBinding = if ([string]::IsNullOrWhiteSpace([string]$contract.nodeExecutable)) { $null } else { & $getBoundNodeRecord $contract }
        $expectedCmdBinding = if ([string]::IsNullOrWhiteSpace([string]$contract.cmdExecutable)) { $null } else { & $getBoundCmdRecord $contract }
        if (-not (& $fixedRuntimeBindingsMatch $contract) -or -not (& $repositoryMatches $contract $expectedCommit)) {
            return & $refuse 'repository-invalid'
        }
        $expectedPnpmBinding = & $getPnpmBinding $contract $pnpmExecutable
        if ($null -eq $expectedPnpmBinding -or [string]$expectedPnpmBinding.sha256 -cne $expectedPnpmSha256) {
            return & $refuse 'pnpm-binding-invalid'
        }
    }
    if ($null -ne $TestContract -and $contract -is [Collections.IDictionary] -and
        $contract.Contains('primaryOutcomeEvidenceForTest')) {
        return & $projectResolvedOutcome $mode $contract.primaryOutcomeEvidenceForTest
    }

    if ($mode -ceq '-RestoreOnly') {
        try {
        Initialize-IntentArcPreflightNativeProcessType
        try {
            if ($null -ne $TestContract -and $null -ne $contract.beforeRecoveryParentGuard) {
                & $contract.beforeRecoveryParentGuard
            }
            $preservationParentSetupGuard = [IntentArc.Preflight.DirectoryComponentGuard]::OpenForCreation(
                [string]$contract.preservationParent
            )
            if (-not $preservationParentSetupGuard.MatchesPath([string]$contract.preservationParent) -or
                ($useProductionStateSecurity -and
                 -not [IntentArc.Preflight.StateFileSecurity]::ValidateParent([string]$contract.preservationParent))) {
                return & $refuse 'preservation-state-invalid'
            }
        } catch {
            return & $refuse 'preservation-state-invalid'
        }
        $recoveryEvidence = [ordered]@{
            phase = 'validated'; childStarted = $false; childExitCode = $null; outRestored = $false
            cleanupCategory = 'none'; childSettlementFailed = $false
            restorationConflict = $false; restorationFailed = $false; restorationRestored = $false
            stateCategory = 'none'; preservationFailed = $false; repositoryInvalid = $false
            pnpmBindingInvalid = $false; childCategory = 'none'; receiptInvalid = $false
        }
        $stateEntry = & $probeExactEntry ([string]$contract.statePath)
        if ($stateEntry -cne 'present' -or $null -eq (& $getOrdinaryFile ([string]$contract.statePath))) {
            $recoveryEvidence.stateCategory = 'preservation-state-invalid'
            return & $projectResolvedOutcome $mode $recoveryEvidence
        }
        try {
            $state = & $readLockedState $contract
        } catch {
            $recoveryEvidence.stateCategory = 'preservation-state-invalid'
            return & $projectResolvedOutcome $mode $recoveryEvidence
        }
        if (-not (& $isValidState $contract $state $expectedCommit $pnpmExecutable $expectedPnpmSha256) -or
            @('prepared', 'preserved', 'child-started', 'child-settled') -cnotcontains [string]$state.phase) {
            $recoveryEvidence.stateCategory = 'preservation-state-invalid'
            return & $projectResolvedOutcome $mode $recoveryEvidence
        }
        $recoverySourcePhase = [string]$state.phase
        $journal.lastDurablePhase = $recoverySourcePhase

        $recoverySourceState = & $probeRecoveryExactEntry ([string]$contract.sourcePath)
        $recoveryDestinationState = & $probeRecoveryExactEntry ([string]$contract.destinationPath)
        if ($recoverySourceState -ceq 'indeterminate' -or $recoveryDestinationState -ceq 'indeterminate') {
            $recoveryEvidence.restorationFailed = $true
        } elseif ($recoverySourceState -cne 'absent' -or $recoveryDestinationState -cne 'directory') {
            $recoveryEvidence.restorationConflict = $true
        } elseif ($null -eq (& $getOrdinaryDirectoryIdentity ([string]$contract.runRoot)) -or
            -not (& $identityMatches $state.directory ([string]$contract.destinationPath) ([IO.Path]::GetFullPath([string]$contract.destinationPath)))) {
            $recoveryEvidence.stateCategory = 'preservation-state-invalid'
        }

        if (-not $recoveryEvidence.restorationConflict -and -not $recoveryEvidence.restorationFailed -and
            [string]$recoveryEvidence.stateCategory -ceq 'none' -and
            ($null -eq $TestContract -or $contract.useStableRecovery -eq $true)) {
            try {
                if ($null -ne $TestContract -and $null -ne $contract.beforeStableRecoveryOpen) {
                    & $contract.beforeStableRecoveryOpen
                }
                # Hold the exact retained directory and both parents before recovery authority is journaled.
                Initialize-IntentArcPreflightNativeProcessType
                $stableRenameSession = [IntentArc.Preflight.DirectoryRenameSession]::Open(
                    [string]$contract.destinationPath,
                    [string]$contract.repositoryRoot,
                    [string]$contract.runRoot,
                    $true
                )
                if ([string]$stableRenameSession.Identity -cne [string]$state.directory.stableIdentity) {
                    $recoveryEvidence.stateCategory = 'preservation-state-invalid'
                } elseif ($null -ne $TestContract -and $null -ne $contract.afterStableRecoveryOpen) {
                    try { & $contract.afterStableRecoveryOpen } catch {
                        $recoveryEvidence.restorationFailed = $true
                    }
                }
            } catch {
                $recoveryEvidence.restorationFailed = $true
            }
        }

        try {
            $childAbsent = if ($null -ne $TestContract -and $null -ne $contract.proveChildAbsent) {
                & $contract.proveChildAbsent $state.child
            } else {
                Initialize-IntentArcPreflightNativeProcessType
                [IntentArc.Preflight.NativeProcess]::ProveSettlement(
                    [string]$state.child.jobName,
                    $(if ($null -eq $state.child.rootProcessId) { 0 } else { [int]$state.child.rootProcessId }),
                    [string]$state.child.rootStartTimeUtc
                )
            }
        } catch {
            $childAbsent = $false
        }
        if ($childAbsent -ne $true) {
            $recoveryEvidence.childSettlementFailed = $true
            if ($null -ne $stableRenameSession) { $stableRenameSession.Dispose(); $stableRenameSession = $null }
            return & $projectResolvedOutcome $mode $recoveryEvidence
        }
        if ($recoveryEvidence.restorationConflict -or $recoveryEvidence.restorationFailed -or
            [string]$recoveryEvidence.stateCategory -cne 'none') {
            if ($null -ne $stableRenameSession) { $stableRenameSession.Dispose(); $stableRenameSession = $null }
            return & $projectResolvedOutcome $mode $recoveryEvidence
        }

        $state.recovery.mode = 'restore-only'
        $state.recovery.sourcePhase = $recoverySourcePhase
        $state.recovery.settlementProvenAt = [DateTime]::UtcNow.ToString('o')
        try {
            & $writeState $contract $state
        } catch {
            if ($null -ne $stableRenameSession) { $stableRenameSession.Dispose(); $stableRenameSession = $null }
            $recoveryEvidence.stateCategory = 'state-evidence-invalid'
            $recoveryEvidence.phase = [string]$journal.lastDurablePhase
            return & $projectResolvedOutcome $mode $recoveryEvidence
        }
        $recoveryEvidence.phase = [string]$journal.lastDurablePhase

        try {
            if ($null -ne $stableRenameSession) {
                if ($null -ne $TestContract -and $null -ne $contract.beforeStableRecovery) {
                    try { & $contract.beforeStableRecovery } catch {
                        $stableRenameSession.Dispose()
                        $stableRenameSession = $null
                        $recoveryEvidence.restorationFailed = $true
                        return & $projectResolvedOutcome $mode $recoveryEvidence
                    }
                }
            }
            & $moveDirectory $contract ([string]$contract.destinationPath) ([string]$contract.sourcePath)
        } catch {
            if ($null -ne $stableRenameSession) { $stableRenameSession.Dispose(); $stableRenameSession = $null }
            $recoveryEvidence.restorationFailed = $true
            return & $projectResolvedOutcome $mode $recoveryEvidence
        }
        try {
            if ($null -ne $TestContract -and $null -ne $contract.beforeRecoveryIdentityVerification) {
                & $contract.beforeRecoveryIdentityVerification
            }
            $recoveryIdentityMatches = if ($null -ne $TestContract -and $null -ne $contract.verifyRecoveryIdentityAfterMove) {
                (& $contract.verifyRecoveryIdentityAfterMove $state.directory) -eq $true
            } else {
                & $identityMatches $state.directory ([string]$contract.sourcePath) ([IO.Path]::GetFullPath([string]$contract.sourcePath))
            }
            $recoveryDestinationAfter = & $probeExactEntry ([string]$contract.destinationPath)
        } catch {
            $recoveryIdentityMatches = $false
            $recoveryDestinationAfter = 'indeterminate'
        }
        if (-not $recoveryIdentityMatches -or $recoveryDestinationAfter -cne 'absent') {
            if ($null -ne $stableRenameSession) { $stableRenameSession.Dispose(); $stableRenameSession = $null }
            $recoveryEvidence.restorationFailed = $true
            return & $projectResolvedOutcome $mode $recoveryEvidence
        }
        $recoveryEvidence.restorationRestored = $true
        $recoveryEvidence.outRestored = $true
        $state.phase = 'restored'
        $state.timestamps.restoredAt = [DateTime]::UtcNow.ToString('o')
        try {
            if (-not (& $writeAdvancedStateIfValid $contract $state)) { throw 'state-invalid' }
        } catch {
            if ($null -ne $stableRenameSession) { $stableRenameSession.Dispose(); $stableRenameSession = $null }
            $recoveryEvidence.stateCategory = 'state-evidence-invalid'
            $recoveryEvidence.phase = [string]$journal.lastDurablePhase
            return & $projectResolvedOutcome $mode $recoveryEvidence
        }
        $recoveryEvidence.phase = [string]$journal.lastDurablePhase
        if ($null -ne $stableRenameSession) { $stableRenameSession.Dispose(); $stableRenameSession = $null }

        try {
            $profileIdentity = $state.ownedRoots.profile
            $localAppDataIdentity = $state.ownedRoots.localAppData
            try {
                Initialize-IntentArcPreflightNativeProcessType
                $profileGuard = [IntentArc.Preflight.DirectoryComponentGuard]::Open([string]$contract.childProfilePath)
                if (-not (& $heldDirectoryBoundaryMatches $profileIdentity ([string]$contract.childProfilePath) $profileGuard) -or
                    -not (& $stableDirectoryBoundaryMatches $profileIdentity ([string]$contract.childProfilePath))) {
                    $profileGuard.Dispose(); $profileGuard = $null
                }
            } catch {
                if ($null -ne $profileGuard) { $profileGuard.Dispose(); $profileGuard = $null }
            }
            try {
                Initialize-IntentArcPreflightNativeProcessType
                $localAppDataGuard = [IntentArc.Preflight.DirectoryComponentGuard]::Open([string]$contract.childLocalAppDataPath)
                if (-not (& $heldDirectoryBoundaryMatches $localAppDataIdentity ([string]$contract.childLocalAppDataPath) $localAppDataGuard) -or
                    -not (& $stableDirectoryBoundaryMatches $localAppDataIdentity ([string]$contract.childLocalAppDataPath))) {
                    $localAppDataGuard.Dispose(); $localAppDataGuard = $null
                }
            } catch {
                if ($null -ne $localAppDataGuard) { $localAppDataGuard.Dispose(); $localAppDataGuard = $null }
            }
            if ($null -ne $profileGuard -and $null -ne $localAppDataGuard) {
                try {
                    $runRootCleanupIdentity = & $getOrdinaryDirectoryIdentity ([string]$contract.runRoot)
                    if ($null -eq $runRootCleanupIdentity) { throw 'run-root-recovery-authority-invalid' }
                    $runRootCleanupIdentity['stableIdentity'] = & $getStableDirectoryIdentity $contract ([string]$contract.runRoot)
                    if ([string]$runRootCleanupIdentity.stableIdentity -cnotmatch '^[a-f0-9]{8}:[a-f0-9]{16}$') {
                        throw 'run-root-recovery-authority-invalid'
                    }
                } catch { $runRootCleanupIdentity = $null }
            }

            $profileStatus = & $removeOwnedRoot $contract $profileIdentity $contract.childProfilePath $profileGuard
            $localAppDataStatus = & $removeOwnedRoot $contract $localAppDataIdentity $contract.childLocalAppDataPath $localAppDataGuard
            $destinationAbsent = (& $probeExactEntry ([string]$contract.destinationPath)) -ceq 'absent'
            $runRootStatus = & $removeRunRoot $contract $destinationAbsent $profileStatus $localAppDataStatus
            $state.cleanup.profileStatus = [string]$profileStatus
            $state.cleanup.localAppDataStatus = [string]$localAppDataStatus
            $state.cleanup.runRootStatus = [string]$runRootStatus
            $allCleanupRemoved = [string]$profileStatus -ceq 'removed' -and
                [string]$localAppDataStatus -ceq 'removed' -and [string]$runRootStatus -ceq 'removed'
            $state.cleanup.category = if ($allCleanupRemoved) { 'none' } else { 'residue-invalid' }
            $recoveryEvidence.cleanupCategory = [string]$state.cleanup.category
            $state.phase = 'complete'
            $state.timestamps.completedAt = [DateTime]::UtcNow.ToString('o')
            try {
                if (-not (& $writeAdvancedStateIfValid $contract $state)) { throw 'state-invalid' }
            } catch {
                $recoveryEvidence.stateCategory = 'state-evidence-invalid'
            }
            $recoveryEvidence.phase = [string]$journal.lastDurablePhase
            return & $projectResolvedOutcome $mode $recoveryEvidence
        } finally {
            if ($null -ne $localAppDataGuard) { $localAppDataGuard.Dispose(); $localAppDataGuard = $null }
            if ($null -ne $profileGuard) { $profileGuard.Dispose(); $profileGuard = $null }
        }
        } finally {
            if ($null -ne $preservationParentSetupGuard) {
                $preservationParentSetupGuard.Dispose(); $preservationParentSetupGuard = $null
            }
        }
    }

    $receiptState = & $probeExactEntry ([string]$contract.receiptPath)
    if ($receiptState -ceq 'present') { return & $refuse 'preflight-id-used' }
    if ($receiptState -cne 'absent') { return & $refuse 'repository-invalid' }
    $sourceIdentity = & $getOrdinaryDirectoryIdentity ([string]$contract.sourcePath)
    if ($null -eq $sourceIdentity) {
        return & $refuse 'out-source-invalid'
    }
    $sourceStableIdentity = & $getStableDirectoryIdentity $contract ([string]$contract.sourcePath)
    if ([string]$sourceStableIdentity -cnotmatch '^[a-f0-9]{8}:[a-f0-9]{16}$') {
        return & $refuse 'out-source-invalid'
    }
    $sourceIdentity['stableIdentity'] = $sourceStableIdentity
    $runRootState = & $probeExactEntry ([string]$contract.runRoot)
    if ($runRootState -cne 'absent') { return & $refuse 'preservation-state-invalid' }
    $destinationState = & $probeExactEntry ([string]$contract.destinationPath)
    if ($destinationState -cne 'absent') { return & $refuse 'preservation-state-invalid' }
    $stateState = & $probeExactEntry ([string]$contract.statePath)
    if ($stateState -cne 'absent') { return & $refuse 'preservation-state-invalid' }

    $now = { [DateTime]::UtcNow.ToString('o') }
    $timestamps = [ordered]@{
        preparedAt = $null
        preservedAt = $null
        childStartedAt = $null
        childSettledAt = $null
        restoredAt = $null
        completedAt = $null
    }
    $state = [ordered]@{
        schema = 'intentarc.preflight-out-preservation-state/v2'
        sourcePath = [string]$contract.sourcePath
        destinationPath = [string]$contract.destinationPath
        runId = [string]$contract.runId
        expectedCommit = $expectedCommit
        directory = $sourceIdentity
        ownedRoots = [ordered]@{ profile = $null; localAppData = $null }
        pnpm = [ordered]@{ path = $pnpmExecutable; sha256 = $expectedPnpmSha256 }
        child = [ordered]@{
            jobName = [string]$contract.jobName
            rootProcessId = $null
            rootStartTimeUtc = $null
            assignmentStatus = 'not-attempted'
            settlementStatus = 'not-started'
            terminationReason = 'not-started'
            exitCode = $null
            stdoutBytes = [int64]0
            stderrBytes = [int64]0
            outputOverflow = $false
            timedOut = $false
            canceled = $false
            infrastructureFailure = $false
        }
        recovery = [ordered]@{ mode = 'none'; sourcePhase = $null; settlementProvenAt = $null }
        cleanup = [ordered]@{
            localAppDataStatus = 'pending'
            profileStatus = 'pending'
            runRootStatus = 'pending'
            category = 'none'
        }
        timestamps = $timestamps
        phase = 'prepared'
    }
    try {
        Initialize-IntentArcPreflightNativeProcessType
        $superpowersSetupGuard = [IntentArc.Preflight.DirectoryComponentGuard]::OpenForCreation(
            [string]$contract.superpowersPath
        )
        if ($useProductionStateSecurity) {
            $preservationParentSetupGuard = [IntentArc.Preflight.DirectoryComponentGuard]::OpenOrCreateProtectedStateParent(
                $superpowersSetupGuard,
                'preflight-out-preservation',
                [string]$contract.preservationParent
            )
        } elseif ($parentState -ceq 'present') {
            $preservationParentSetupGuard = [IntentArc.Preflight.DirectoryComponentGuard]::OpenForCreation(
                [string]$contract.preservationParent
            )
        }
        if (-not (& $protectStateAccess $contract)) { throw 'state-access-invalid' }
        if ($null -eq $preservationParentSetupGuard) {
            $preservationParentSetupGuard = [IntentArc.Preflight.DirectoryComponentGuard]::OpenForCreation(
                [string]$contract.preservationParent
            )
        }
        if (($useProductionStateSecurity -and
             -not [IntentArc.Preflight.StateFileSecurity]::ValidateParent([string]$contract.preservationParent)) -or
            (-not $useProductionStateSecurity -and
             $null -eq (& $getOrdinaryDirectoryIdentity ([string]$contract.preservationParent))) -or
            -not $preservationParentSetupGuard.MatchesPath([string]$contract.preservationParent)) {
            throw 'preservation-parent-invalid'
        }
        if ($null -ne $TestContract -and $null -ne $contract.beforeOwnedLayoutCreation) {
            & $contract.beforeOwnedLayoutCreation
        }
        $runRootSetupGuard = [IntentArc.Preflight.DirectoryComponentGuard]::CreateExclusive(
            $preservationParentSetupGuard,
            [IO.Path]::GetFileName([string]$contract.runRoot)
        )
        $profileGuard = [IntentArc.Preflight.DirectoryComponentGuard]::CreateExclusive($runRootSetupGuard, 'profile')
        if ($null -ne $TestContract -and $null -ne $contract.beforeLocalAppDataGuard) {
            & $contract.beforeLocalAppDataGuard
        }
        $localAppDataGuard = [IntentArc.Preflight.DirectoryComponentGuard]::CreateExclusive($runRootSetupGuard, 'localappdata')
        $roamingSetupGuard = [IntentArc.Preflight.DirectoryComponentGuard]::CreateExclusive($localAppDataGuard, 'Roaming')
        $roamingSetupGuard.Dispose()
        $roamingSetupGuard = $null
        if ($null -ne $TestContract -and $null -ne $contract.beforeOwnedRootGuards) {
            & $contract.beforeOwnedRootGuards
        }
        if ($null -eq (& $getOrdinaryDirectoryIdentity ([string]$contract.runRoot)) -or
            $null -eq (& $getOrdinaryDirectoryIdentity ([string]$contract.childRoamingAppDataPath))) {
            throw 'owned-root-layout-invalid'
        }
        $state.ownedRoots.profile = & $newOwnedRootEvidence $contract.childProfilePath $profileGuard.Identity
        $state.ownedRoots.localAppData = & $newOwnedRootEvidence $contract.childLocalAppDataPath $localAppDataGuard.Identity
        $profileIdentity = $state.ownedRoots.profile
        $localAppDataIdentity = $state.ownedRoots.localAppData
        $runRootCleanupIdentity = & $getOrdinaryDirectoryIdentity ([string]$contract.runRoot)
        if ($null -eq $runRootCleanupIdentity) { throw 'run-root-identity-invalid' }
        $runRootCleanupIdentity['stableIdentity'] = & $getStableDirectoryIdentity $contract ([string]$contract.runRoot)
        if ([string]$runRootCleanupIdentity.stableIdentity -cnotmatch '^[a-f0-9]{8}:[a-f0-9]{16}$') {
            throw 'run-root-identity-invalid'
        }
        if (-not (& $heldDirectoryBoundaryMatches $profileIdentity ([string]$contract.childProfilePath) $profileGuard) -or
            -not (& $heldDirectoryBoundaryMatches $localAppDataIdentity ([string]$contract.childLocalAppDataPath) $localAppDataGuard)) {
            throw 'owned-root-boundary-invalid'
        }
        $timestamps.preparedAt = & $now
        if ($null -ne $TestContract -and $null -ne $contract.beforePreparedStateWrite) {
            & $contract.beforePreparedStateWrite $state
        }
        if ($null -eq (& $getOrdinaryDirectoryIdentity ([string]$contract.childRoamingAppDataPath))) {
            throw 'roaming-boundary-invalid'
        }
        $preparedWriteAttempted = $true
        & $writeState $contract $state
        $preparedStateDurable = $true
        if ($null -eq $TestContract -or $contract.useStableRename -eq $true) {
            Initialize-IntentArcPreflightNativeProcessType
            $stableRenameSession = [IntentArc.Preflight.DirectoryRenameSession]::Open(
                [string]$contract.sourcePath,
                [string]$contract.repositoryRoot,
                [string]$contract.runRoot,
                $false
            )
        }
        if ($null -ne $runRootSetupGuard) { $runRootSetupGuard.Dispose(); $runRootSetupGuard = $null }
    } catch {
        if ($null -ne $roamingSetupGuard) { $roamingSetupGuard.Dispose(); $roamingSetupGuard = $null }
        if ($null -ne $runRootSetupGuard) { $runRootSetupGuard.Dispose(); $runRootSetupGuard = $null }
        if ($null -ne $preservationParentSetupGuard) { $preservationParentSetupGuard.Dispose(); $preservationParentSetupGuard = $null }
        if ($null -ne $superpowersSetupGuard) { $superpowersSetupGuard.Dispose(); $superpowersSetupGuard = $null }
        if ($null -ne $localAppDataGuard) { $localAppDataGuard.Dispose(); $localAppDataGuard = $null }
        if ($null -ne $profileGuard) { $profileGuard.Dispose(); $profileGuard = $null }
        if ($null -ne $stableRenameSession) { $stableRenameSession.Dispose(); $stableRenameSession = $null }
        if (-not $preparedWriteAttempted) { return & $refuse 'preservation-state-invalid' }
        if (-not $preparedStateDurable) {
            return & $result 'FAIL' 'state-evidence-invalid' ([string]$journal.lastDurablePhase) $false $null $false
        }
        return & $result 'FAIL' 'out-preservation-failed' ([string]$journal.lastDurablePhase) $false $null $false
    }
    try {
    $boundaryIdentities = [ordered]@{
        repositoryRoot = & $getOrdinaryDirectoryIdentity ([string]$contract.repositoryRoot)
        superpowersPath = & $getOrdinaryDirectoryIdentity ([string]$contract.superpowersPath)
        preservationParent = & $getOrdinaryDirectoryIdentity ([string]$contract.preservationParent)
        runRoot = $runRootCleanupIdentity
        childProfilePath = $profileIdentity
        childLocalAppDataPath = $localAppDataIdentity
    }
    $boundariesMatch = {
        return (& $directoryBoundaryMatches $boundaryIdentities.repositoryRoot ([string]$contract.repositoryRoot)) -and
            (& $directoryBoundaryMatches $boundaryIdentities.superpowersPath ([string]$contract.superpowersPath)) -and
            (& $directoryBoundaryMatches $boundaryIdentities.preservationParent ([string]$contract.preservationParent)) -and
            (& $directoryBoundaryMatches $boundaryIdentities.runRoot ([string]$contract.runRoot)) -and
            (& $heldDirectoryBoundaryMatches $boundaryIdentities.childProfilePath ([string]$contract.childProfilePath) $profileGuard) -and
            (& $heldDirectoryBoundaryMatches $boundaryIdentities.childLocalAppDataPath ([string]$contract.childLocalAppDataPath) $localAppDataGuard)
    }

    $phase = 'prepared'
    $category = 'none'
    $cleanupCategory = 'none'
    $childStarted = $false
    $childExitCode = $null
    $outRestored = $false
    $preservationAttempted = $false
    $namespacePreserved = $false
    $restorationAuthorized = $true
    $boundariesValid = $true
    $childOutcomeAvailable = $false
    $restoredStateDurable = $false
    $executeEvidence = [ordered]@{
        phase = 'prepared'; childStarted = $false; childExitCode = $null; outRestored = $false
        cleanupCategory = 'none'; childSettlementFailed = $false
        restorationConflict = $false; restorationFailed = $false; restorationRestored = $false
        stateCategory = 'none'; preservationFailed = $false; repositoryInvalid = $false
        pnpmBindingInvalid = $false; childCategory = 'none'; receiptInvalid = $false
    }
    try {
        try {
            $preservationAttempted = $true
            if ($null -ne $stableRenameSession -and $null -ne $TestContract -and $null -ne $contract.beforeStableRename) {
                try { & $contract.beforeStableRename } catch {
                    $boundariesValid = $false
                    $category = 'repository-invalid'
                    $executeEvidence.repositoryInvalid = $true
                    throw
                }
            }
            if (-not (& $boundariesMatch)) {
                $boundariesValid = $false
                $category = 'repository-invalid'
                $executeEvidence.repositoryInvalid = $true
                throw 'repository-boundary-drift'
            }
            & $moveDirectory $contract ([string]$contract.sourcePath) ([string]$contract.destinationPath)
            $namespacePreserved = $true
            $phase = 'preserved'
            $state.phase = 'preserved'
            $timestamps.preservedAt = & $now
            & $writeState $contract $state
        } catch {
            $category = if ($namespacePreserved) { 'state-evidence-invalid' } else { 'out-preservation-failed' }
            if ($namespacePreserved) { $executeEvidence.stateCategory = 'state-evidence-invalid' }
            elseif (-not $executeEvidence.repositoryInvalid -and -not $executeEvidence.pnpmBindingInvalid) {
                $executeEvidence.preservationFailed = $true
            }
            $phase = [string]$journal.lastDurablePhase
            throw
        }

        if ((& $probeExactEntry ([string]$contract.sourcePath)) -cne 'absent' -or
            -not (& $identityMatches $sourceIdentity ([string]$contract.destinationPath) ([IO.Path]::GetFullPath([string]$contract.destinationPath)))) {
            $category = 'out-preservation-failed'
            $executeEvidence.preservationFailed = $true
            throw 'preservation-validation-failed'
        }
        if (-not (& $repositoryMatches $contract $expectedCommit)) {
            $category = 'repository-invalid'
            $executeEvidence.repositoryInvalid = $true
            throw 'repository-drift'
        }
        if (-not (& $fixedRuntimeBindingsMatch $contract)) {
            $category = 'repository-invalid'
            $executeEvidence.repositoryInvalid = $true
            throw 'runtime-binding-drift'
        }
        if (-not (& $pnpmBindingMatches $contract $pnpmExecutable $expectedPnpmBinding $expectedPnpmSha256)) {
            $category = 'pnpm-binding-invalid'
            $executeEvidence.pnpmBindingInvalid = $true
            throw 'pnpm-drift'
        }

        if ($null -eq $TestContract -or $contract.useStableReceiptBoundary -eq $true) {
            try {
                $receiptParent = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath([string]$contract.receiptPath))
                [void][IO.Directory]::CreateDirectory($receiptParent)
                $receiptParentIdentity = & $getOrdinaryDirectoryIdentity $receiptParent
                if ($null -eq $receiptParentIdentity) { throw 'receipt-boundary-invalid' }
                $receiptParentIdentity['stableIdentity'] = & $getStableDirectoryIdentity $contract $receiptParent
                if ([string]$receiptParentIdentity.stableIdentity -cnotmatch '^[a-f0-9]{8}:[a-f0-9]{16}$') {
                    throw 'receipt-boundary-invalid'
                }
                if ($null -ne $TestContract -and $null -ne $contract.beforeReceiptBoundaryGuard) {
                    & $contract.beforeReceiptBoundaryGuard
                }
                Initialize-IntentArcPreflightNativeProcessType
                $receiptBoundaryGuard = [IntentArc.Preflight.DirectoryComponentGuard]::Open($receiptParent)
                if (-not (& $identityMatches $receiptParentIdentity $receiptParent $receiptParent)) {
                    throw 'receipt-boundary-invalid'
                }
            } catch {
                $category = 'repository-invalid'
                $executeEvidence.repositoryInvalid = $true
                throw
            }
        }

        $phase = 'child-started'
        $state.phase = 'child-started'
        $state.child.assignmentStatus = 'attempted'
        $state.child.settlementStatus = 'unsettled'
        $state.child.terminationReason = 'unknown'
        $timestamps.childStartedAt = & $now
        try {
            & $writeState $contract $state
        } catch {
            $category = 'state-evidence-invalid'
            $executeEvidence.stateCategory = 'state-evidence-invalid'
            $phase = [string]$journal.lastDurablePhase
            throw
        }
        try {
            $child = & $invokeChild $contract $pnpmExecutable
            $childStarted = $child.started -eq $true
            if ($null -ne $child.exitCode) { $childExitCode = [int]$child.exitCode }
            $state.child = & $projectChildEvidence $child
            $childOutcomeAvailable = $true
            $phase = 'child-settled'
            $state.phase = 'child-settled'
            $timestamps.childSettledAt = & $now
            try {
                & $writeState $contract $state
            } catch {
                $category = 'state-evidence-invalid'
                $executeEvidence.stateCategory = 'state-evidence-invalid'
                $phase = [string]$journal.lastDurablePhase
            }
            $childCategory = 'none'
            if ([string]$state.child.terminationReason -ceq 'settlement-failed') {
                $childCategory = 'child-settlement-failed'
                $executeEvidence.childSettlementFailed = $true
                $restorationAuthorized = $false
            } elseif ([string]$state.child.terminationReason -ceq 'output-overflow') {
                $childCategory = 'preflight-failed'
            } elseif ([string]$state.child.terminationReason -ceq 'infrastructure-failure') {
                $childCategory = if ($childStarted) { 'preflight-failed' } else { 'preflight-start-failed' }
            } elseif ([string]$state.child.terminationReason -ceq 'timeout') {
                $childCategory = 'preflight-timeout'
            } elseif ([string]$state.child.terminationReason -ceq 'canceled') {
                $childCategory = 'preflight-canceled'
            } elseif (-not $childStarted) {
                $childCategory = 'preflight-start-failed'
            } elseif ($childExitCode -ne 0) {
                $childCategory = 'preflight-failed'
            }
            if ($childCategory -cne 'child-settlement-failed') {
                $executeEvidence.childCategory = [string]$childCategory
            }
            if ($category -ceq 'none') { $category = $childCategory }
        } catch {
            $category = 'child-settlement-failed'
            $executeEvidence.childSettlementFailed = $true
            $restorationAuthorized = $false
            $childStarted = $false
            $childExitCode = $null
        }
        if (-not (& $repositoryMatches $contract $expectedCommit)) {
            $category = 'repository-invalid'
            $executeEvidence.repositoryInvalid = $true
        }
        if (-not (& $fixedRuntimeBindingsMatch $contract)) {
            $category = 'repository-invalid'
            $executeEvidence.repositoryInvalid = $true
        }
        if (-not (& $pnpmBindingMatches $contract $pnpmExecutable $expectedPnpmBinding $expectedPnpmSha256)) {
            $category = 'pnpm-binding-invalid'
            $executeEvidence.pnpmBindingInvalid = $true
        }
    } catch {
        if ($category -ceq 'none') {
            $category = 'out-preservation-failed'
            $executeEvidence.preservationFailed = $true
        }
    } finally {
        if ($preservationAttempted -and $restorationAuthorized) {
            if ($childOutcomeAvailable) {
                $state.phase = 'child-settled'
                try {
                    & $writeState $contract $state
                    $phase = [string]$journal.lastDurablePhase
                } catch {
                    $category = 'state-evidence-invalid'
                    $executeEvidence.stateCategory = 'state-evidence-invalid'
                    $phase = [string]$journal.lastDurablePhase
                }
            }
            $sourceStateAfter = & $probeExactEntry ([string]$contract.sourcePath)
            $destinationStateAfter = & $probeExactEntry ([string]$contract.destinationPath)
            if ($sourceStateAfter -ceq 'absent' -and $destinationStateAfter -ceq 'present') {
                try {
                    $namespacePreserved = $true
                    if ($null -eq $timestamps.preservedAt) {
                        $phase = 'preserved'
                        $state.phase = 'preserved'
                        $timestamps.preservedAt = & $now
                    }
                    & $moveDirectory $contract ([string]$contract.destinationPath) ([string]$contract.sourcePath)
                    $outRestored = $true
                    $executeEvidence.restorationRestored = $true
                } catch {
                    $category = 'out-restoration-failed'
                    $executeEvidence.restorationFailed = $true
                    $outRestored = $false
                }
            } elseif ($sourceStateAfter -ceq 'present' -and $destinationStateAfter -ceq 'absent') {
                $outRestored = $true
                $executeEvidence.restorationRestored = $true
            } else {
                $category = 'out-restoration-conflict'
                $executeEvidence.restorationConflict = $true
                $outRestored = $false
            }

            if ($outRestored) {
                $restoredIdentityMatches = & $identityMatches $sourceIdentity ([string]$contract.sourcePath) ([IO.Path]::GetFullPath([string]$contract.sourcePath))
                $restoredDestinationState = & $probeExactEntry ([string]$contract.destinationPath)
                if (-not $restoredIdentityMatches -or $restoredDestinationState -cne 'absent') {
                    $category = 'out-restoration-failed'
                    $executeEvidence.restorationFailed = $true
                    $outRestored = $false
                } elseif ($namespacePreserved) {
                    $phase = 'restored'
                    $state.phase = 'restored'
                    $timestamps.restoredAt = & $now
                    try {
                        $restoredStateDurable = & $writeAdvancedStateIfValid $contract $state
                        if (-not $restoredStateDurable) {
                            $category = 'state-evidence-invalid'
                            $executeEvidence.stateCategory = 'state-evidence-invalid'
                            $phase = [string]$journal.lastDurablePhase
                        }
                    } catch {
                        $category = 'state-evidence-invalid'
                        $executeEvidence.stateCategory = 'state-evidence-invalid'
                        $phase = [string]$journal.lastDurablePhase
                    }
                }
            }
        }
    }

    if (-not $outRestored) {
        if ($null -ne $receiptBoundaryGuard) { $receiptBoundaryGuard.Dispose(); $receiptBoundaryGuard = $null }
        if ($null -ne $localAppDataGuard) { $localAppDataGuard.Dispose(); $localAppDataGuard = $null }
        if ($null -ne $profileGuard) { $profileGuard.Dispose(); $profileGuard = $null }
        if ($null -ne $stableRenameSession) { $stableRenameSession.Dispose(); $stableRenameSession = $null }
        $executeEvidence.phase = [string]$journal.lastDurablePhase
        $executeEvidence.childStarted = $childStarted
        $executeEvidence.childExitCode = $childExitCode
        $executeEvidence.outRestored = $false
        return & $projectResolvedOutcome $mode $executeEvidence
    }
    if (-not $boundariesValid) {
        if ($null -ne $receiptBoundaryGuard) { $receiptBoundaryGuard.Dispose(); $receiptBoundaryGuard = $null }
        if ($null -ne $localAppDataGuard) { $localAppDataGuard.Dispose(); $localAppDataGuard = $null }
        if ($null -ne $profileGuard) { $profileGuard.Dispose(); $profileGuard = $null }
        if ($null -ne $stableRenameSession) { $stableRenameSession.Dispose(); $stableRenameSession = $null }
        $executeEvidence.repositoryInvalid = $true
        $executeEvidence.phase = [string]$journal.lastDurablePhase
        $executeEvidence.childStarted = $childStarted
        $executeEvidence.childExitCode = $childExitCode
        $executeEvidence.outRestored = $true
        return & $projectResolvedOutcome $mode $executeEvidence
    }
    if (-not $restoredStateDurable) {
        if ($null -ne $receiptBoundaryGuard) { $receiptBoundaryGuard.Dispose(); $receiptBoundaryGuard = $null }
        if ($null -ne $localAppDataGuard) { $localAppDataGuard.Dispose(); $localAppDataGuard = $null }
        if ($null -ne $profileGuard) { $profileGuard.Dispose(); $profileGuard = $null }
        if ($null -ne $stableRenameSession) { $stableRenameSession.Dispose(); $stableRenameSession = $null }
        if (-not $executeEvidence.preservationFailed) { $executeEvidence.stateCategory = 'state-evidence-invalid' }
        $executeEvidence.phase = [string]$journal.lastDurablePhase
        $executeEvidence.childStarted = $childStarted
        $executeEvidence.childExitCode = $childExitCode
        $executeEvidence.outRestored = $true
        return & $projectResolvedOutcome $mode $executeEvidence
    }
    if ($null -ne $stableRenameSession) { $stableRenameSession.Dispose(); $stableRenameSession = $null }
    if (-not (& $repositoryMatches $contract $expectedCommit)) {
        $category = 'repository-invalid'
        $executeEvidence.repositoryInvalid = $true
    }
    if (-not (& $fixedRuntimeBindingsMatch $contract)) {
        $category = 'repository-invalid'
        $executeEvidence.repositoryInvalid = $true
    }
    if (-not (& $pnpmBindingMatches $contract $pnpmExecutable $expectedPnpmBinding $expectedPnpmSha256)) {
        $category = 'pnpm-binding-invalid'
        $executeEvidence.pnpmBindingInvalid = $true
    }
    $profileStatus = & $removeOwnedRoot $contract $state.ownedRoots.profile $contract.childProfilePath $profileGuard
    $localAppDataStatus = & $removeOwnedRoot $contract $state.ownedRoots.localAppData $contract.childLocalAppDataPath $localAppDataGuard
    $destinationAbsent = (& $probeExactEntry ([string]$contract.destinationPath)) -ceq 'absent'
    $runRootStatus = & $removeRunRoot $contract $destinationAbsent $profileStatus $localAppDataStatus
    $state.cleanup.profileStatus = [string]$profileStatus
    $state.cleanup.localAppDataStatus = [string]$localAppDataStatus
    $state.cleanup.runRootStatus = [string]$runRootStatus
    $allCleanupRemoved = [string]$profileStatus -ceq 'removed' -and
        [string]$localAppDataStatus -ceq 'removed' -and [string]$runRootStatus -ceq 'removed'
    $state.cleanup.category = if ($allCleanupRemoved) { 'none' } else { 'residue-invalid' }
    $cleanupCategory = [string]$state.cleanup.category
    $executeEvidence.cleanupCategory = $cleanupCategory

    $phase = 'complete'
    $state.phase = 'complete'
    $timestamps.completedAt = & $now
    try {
        if (-not (& $writeAdvancedStateIfValid $contract $state)) {
            $category = 'state-evidence-invalid'
            $executeEvidence.stateCategory = 'state-evidence-invalid'
            $phase = [string]$journal.lastDurablePhase
        }
    } catch {
        $category = 'state-evidence-invalid'
        $executeEvidence.stateCategory = 'state-evidence-invalid'
        $phase = [string]$journal.lastDurablePhase
    }
    $executeEvidence.receiptInvalid = -not ($childStarted -and $childExitCode -eq 0 -and (& $isValidReceipt $contract))
    if ($null -ne $receiptBoundaryGuard) { $receiptBoundaryGuard.Dispose(); $receiptBoundaryGuard = $null }
    if ($null -ne $localAppDataGuard) { $localAppDataGuard.Dispose(); $localAppDataGuard = $null }
    if ($null -ne $profileGuard) { $profileGuard.Dispose(); $profileGuard = $null }
    if ($null -ne $stableRenameSession) { $stableRenameSession.Dispose(); $stableRenameSession = $null }
    $executeEvidence.phase = [string]$journal.lastDurablePhase
    $executeEvidence.childStarted = $childStarted
    $executeEvidence.childExitCode = $childExitCode
    $executeEvidence.outRestored = $true
    return & $projectResolvedOutcome $mode $executeEvidence
    } finally {
        if ($null -ne $roamingSetupGuard) { $roamingSetupGuard.Dispose(); $roamingSetupGuard = $null }
        if ($null -ne $runRootSetupGuard) { $runRootSetupGuard.Dispose(); $runRootSetupGuard = $null }
        if ($null -ne $preservationParentSetupGuard) { $preservationParentSetupGuard.Dispose(); $preservationParentSetupGuard = $null }
        if ($null -ne $superpowersSetupGuard) { $superpowersSetupGuard.Dispose(); $superpowersSetupGuard = $null }
        if ($null -ne $localAppDataGuard) { $localAppDataGuard.Dispose(); $localAppDataGuard = $null }
        if ($null -ne $profileGuard) { $profileGuard.Dispose(); $profileGuard = $null }
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        $controllerResult = Invoke-IntentArcPreflightOutPreservation -ArgumentsVector @($args)
        if (@($args).Count -gt 0 -and [string]$args[0] -ceq '-RestoreOnly' -and
            [string]$controllerResult.status -ceq 'PASS') {
            throw 'restore-only-pass-invalid'
        }
    } catch {
        $controllerResult = [ordered]@{
            schema = 'intentarc.preflight-out-preservation-result/v2'
            status = 'FAIL'
            category = 'repository-invalid'
            cleanupCategory = 'none'
            phase = 'validated'
            childStarted = $false
            childExitCode = $null
            outRestored = $false
        }
    }
    try {
        $expectedResultKeys = @(
            'schema', 'status', 'category', 'cleanupCategory', 'phase',
            'childStarted', 'childExitCode', 'outRestored'
        )
        $actualResultKeys = @($controllerResult.Keys)
        if ($actualResultKeys.Count -ne $expectedResultKeys.Count) { throw 'result-shape-invalid' }
        for ($index = 0; $index -lt $expectedResultKeys.Count; $index++) {
            if ([string]$actualResultKeys[$index] -cne [string]$expectedResultKeys[$index]) {
                throw 'result-shape-invalid'
            }
        }
        if ([string]$controllerResult.schema -cne 'intentarc.preflight-out-preservation-result/v2' -or
            @('PASS', 'RECOVERED', 'REFUSED', 'FAIL') -cnotcontains [string]$controllerResult.status -or
            @(
                'none', 'recovery-restored', 'arguments-invalid', 'repository-invalid', 'preflight-id-used',
                'out-source-invalid', 'preservation-state-invalid', 'state-evidence-invalid', 'pnpm-binding-invalid',
                'out-preservation-failed', 'preflight-start-failed', 'preflight-failed', 'preflight-timeout',
                'preflight-canceled', 'child-settlement-failed', 'out-restoration-conflict',
                'out-restoration-failed', 'receipt-invalid', 'residue-invalid'
            ) -cnotcontains [string]$controllerResult.category -or
            @('none', 'residue-invalid') -cnotcontains [string]$controllerResult.cleanupCategory -or
            @('validated', 'prepared', 'preserved', 'child-started', 'child-settled', 'restored', 'complete') -cnotcontains [string]$controllerResult.phase -or
            $controllerResult.childStarted -isnot [bool] -or
            ($null -ne $controllerResult.childExitCode -and $controllerResult.childExitCode -isnot [int]) -or
            $controllerResult.outRestored -isnot [bool]) {
            throw 'result-value-invalid'
        }
        $childStartedJson = if ([bool]$controllerResult.childStarted) { 'true' } else { 'false' }
        $childExitCodeJson = if ($null -eq $controllerResult.childExitCode) {
            'null'
        } else {
            ([int]$controllerResult.childExitCode).ToString([Globalization.CultureInfo]::InvariantCulture)
        }
        $outRestoredJson = if ([bool]$controllerResult.outRestored) { 'true' } else { 'false' }
        '{"schema":"' + [string]$controllerResult.schema +
            '","status":"' + [string]$controllerResult.status +
            '","category":"' + [string]$controllerResult.category +
            '","cleanupCategory":"' + [string]$controllerResult.cleanupCategory +
            '","phase":"' + [string]$controllerResult.phase +
            '","childStarted":' + $childStartedJson +
            ',"childExitCode":' + $childExitCodeJson +
            ',"outRestored":' + $outRestoredJson + '}'
    } catch {
        '{"schema":"intentarc.preflight-out-preservation-result/v2","status":"FAIL","category":"repository-invalid","cleanupCategory":"none","phase":"validated","childStarted":false,"childExitCode":null,"outRestored":false}'
        exit 1
    }
    if ($controllerResult.status -cne 'PASS') { exit 1 }
    exit 0
}
