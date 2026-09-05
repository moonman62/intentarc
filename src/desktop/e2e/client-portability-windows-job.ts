import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, parse, relative, resolve, sep, win32 } from "node:path";
import type { SupervisorProcessIdentity } from "./client-portability-supervisor-client.js";

const INVALID_LAUNCH_MESSAGE = "Client portability supervisor launch is invalid.";
const WINDOWS_SYSTEM32_BOUNDARY = "\\\\?\\GLOBALROOT\\SystemRoot\\System32";
const JOB_NAME_PATTERN = /^Local\\IntentArcPortability-[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION_PATTERN = /^(?:codex|claude)-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NONCE_PATTERN = /^[0-9a-f]{64}$/;

export interface ProductionSupervisorLaunchAuthority {
  readonly nodeExecutable: string;
  readonly repositoryRoot: string;
  readonly supervisorBundle: string;
  readonly bridgeExecutable: string;
  readonly settingsRoot: string;
  readonly archivePath: string;
  readonly acceptanceRoot: string;
}

export interface WindowsSupervisorJobHostLaunch {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly jobName: string;
  readonly options: {
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly shell: false;
    readonly windowsHide: true;
    readonly stdio: readonly ["pipe", "pipe", "pipe"];
  };
}

export interface WindowsSupervisorJobBootstrapExpectation {
  readonly pid: number;
  readonly startTime?: string;
  readonly jobName: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly nonce: string;
}

export interface WindowsJobMemberInspection extends SupervisorProcessIdentity {
  readonly jobMember: boolean;
}

export interface WindowsJobMemberObserverDependencies {
  readonly platform: NodeJS.Platform;
  inspectMember(
    pid: number,
    jobName: string,
    deadline: number,
  ): Promise<WindowsJobMemberInspection | undefined>;
}

const exactWindowsSystemExecutable = (relativePath: string): string => {
  const normalized = win32.normalize(relativePath);
  if (
    process.platform !== "win32"
    || win32.isAbsolute(normalized)
    || normalized === ".."
    || normalized.startsWith(`..${win32.sep}`)
  ) throw new Error(INVALID_LAUNCH_MESSAGE);
  const candidate = win32.join(WINDOWS_SYSTEM32_BOUNDARY, normalized);
  const stat = lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(INVALID_LAUNCH_MESSAGE);
  const canonical = realpathSync.native(candidate);
  const suffix = `${win32.sep}System32${win32.sep}${normalized}`.toLowerCase();
  if (!win32.resolve(canonical).toLowerCase().endsWith(suffix)) {
    throw new Error(INVALID_LAUNCH_MESSAGE);
  }
  return canonical;
};

const requireOrdinaryCanonicalPath = (
  path: string,
  kind: "file" | "directory",
): string => {
  try {
    if (!isAbsolute(path) || resolve(path) !== path) throw new Error();
    const canonical = realpathSync.native(path);
    if (process.platform === "win32"
      ? canonical.toLowerCase() !== path.toLowerCase()
      : canonical !== path) throw new Error();
    const root = parse(path).root;
    const suffix = path.slice(root.length).split(sep).filter(Boolean);
    let cursor = root;
    for (const segment of suffix) {
      cursor = resolve(cursor, segment);
      if (lstatSync(cursor).isSymbolicLink()) throw new Error();
    }
    const stat = lstatSync(path);
    if (kind === "file" ? !stat.isFile() : !stat.isDirectory()) throw new Error();
    return canonical;
  } catch {
    throw new Error(INVALID_LAUNCH_MESSAGE);
  }
};

const isInside = (parent: string, child: string): boolean => {
  const suffix = relative(parent, child);
  return suffix !== ""
    && suffix !== ".."
    && !suffix.startsWith(`..${sep}`)
    && !isAbsolute(suffix);
};

export const validateProductionSupervisorLaunchAuthority = (
  input: ProductionSupervisorLaunchAuthority,
): Readonly<ProductionSupervisorLaunchAuthority> => {
  const nodeExecutable = requireOrdinaryCanonicalPath(input.nodeExecutable, "file");
  const repositoryRoot = requireOrdinaryCanonicalPath(input.repositoryRoot, "directory");
  const supervisorBundle = requireOrdinaryCanonicalPath(input.supervisorBundle, "file");
  const bridgeExecutable = requireOrdinaryCanonicalPath(input.bridgeExecutable, "file");
  const settingsRoot = requireOrdinaryCanonicalPath(input.settingsRoot, "directory");
  const archivePath = requireOrdinaryCanonicalPath(input.archivePath, "file");
  const acceptanceRoot = requireOrdinaryCanonicalPath(input.acceptanceRoot, "directory");
  if (
    !isInside(repositoryRoot, supervisorBundle)
    || !isInside(repositoryRoot, bridgeExecutable)
    || !isInside(acceptanceRoot, settingsRoot)
    || !isInside(acceptanceRoot, archivePath)
  ) throw new Error(INVALID_LAUNCH_MESSAGE);
  return Object.freeze({
    nodeExecutable,
    repositoryRoot,
    supervisorBundle,
    bridgeExecutable,
    settingsRoot,
    archivePath,
    acceptanceRoot,
  });
};

export const validateProductionBridgeSessionPaths = (input: {
  readonly bridgeExecutable: string;
  readonly settingsRoot: string;
}): void => {
  requireOrdinaryCanonicalPath(input.bridgeExecutable, "file");
  requireOrdinaryCanonicalPath(input.settingsRoot, "directory");
};

const JOB_HOST_SCRIPT = String.raw`
$ErrorActionPreference='Stop'
if ($args.Count -ne 6) { exit 91 }
function Decode([string]$value) { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($value)) }
$node=Decode $args[0]; $bundle=Decode $args[1]; $jobName=Decode $args[2]
$runId=Decode $args[3]; $sessionId=Decode $args[4]; $nonce=Decode $args[5]
if ($jobName -notmatch '^Local\\IntentArcPortability-[0-9a-f]{64}$') { exit 92 }
$assembly=[AppDomain]::CurrentDomain.DefineDynamicAssembly([Reflection.AssemblyName]::new('IntentArc.PortabilityJob'),[Reflection.Emit.AssemblyBuilderAccess]::Run)
$module=$assembly.DefineDynamicModule('IntentArc.PortabilityJob')
$builder=$module.DefineType('IntentArcPortabilityJobNative',[Reflection.TypeAttributes]::Public -bor [Reflection.TypeAttributes]::Abstract -bor [Reflection.TypeAttributes]::Sealed)
$attributes=[Reflection.MethodAttributes]::Public -bor [Reflection.MethodAttributes]::Static -bor [Reflection.MethodAttributes]::PinvokeImpl
$preserve=[Reflection.MethodImplAttributes]::PreserveSig
function PInvoke([string]$name,[Type]$return,[Type[]]$parameters,[Runtime.InteropServices.CharSet]$charset) {
  $method=$builder.DefinePInvokeMethod($name,'kernel32.dll',$attributes,[Reflection.CallingConventions]::Standard,$return,$parameters,[Runtime.InteropServices.CallingConvention]::Winapi,$charset)
  $method.SetImplementationFlags($method.GetMethodImplementationFlags() -bor $preserve)
}
PInvoke 'CreateJobObject' ([IntPtr]) ([Type[]]@([IntPtr],[string])) ([Runtime.InteropServices.CharSet]::Unicode)
PInvoke 'SetInformationJobObject' ([bool]) ([Type[]]@([IntPtr],[int],[IntPtr],[uint32])) ([Runtime.InteropServices.CharSet]::None)
PInvoke 'AssignProcessToJobObject' ([bool]) ([Type[]]@([IntPtr],[IntPtr])) ([Runtime.InteropServices.CharSet]::None)
PInvoke 'GetProcessTimes' ([bool]) ([Type[]]@([IntPtr],[Int64].MakeByRefType(),[Int64].MakeByRefType(),[Int64].MakeByRefType(),[Int64].MakeByRefType())) ([Runtime.InteropServices.CharSet]::None)
PInvoke 'CloseHandle' ([bool]) ([Type[]]@([IntPtr])) ([Runtime.InteropServices.CharSet]::None)
$native=$builder.CreateType()
$job=$native::CreateJobObject([IntPtr]::Zero,$jobName)
if ($job -eq [IntPtr]::Zero) { exit 93 }
$info=[Runtime.InteropServices.Marshal]::AllocHGlobal(144)
try {
  for ($offset=0; $offset -lt 144; $offset+=4) { [Runtime.InteropServices.Marshal]::WriteInt32($info,$offset,0) }
  [Runtime.InteropServices.Marshal]::WriteInt32($info,16,0x2000)
  if (-not $native::SetInformationJobObject($job,9,$info,144)) { exit 94 }
  $self=[Diagnostics.Process]::GetCurrentProcess()
  if (-not $native::AssignProcessToJobObject($job,$self.Handle)) { exit 95 }
  [long]$creation=0; [long]$exit=0; [long]$kernel=0; [long]$user=0
  if (-not $native::GetProcessTimes($self.Handle,[ref]$creation,[ref]$exit,[ref]$kernel,[ref]$user)) { exit 96 }
  $ticks=([DateTime]::FromFileTimeUtc($creation)).Ticks; $ticks=$ticks-($ticks%10)
  $bootstrap=[ordered]@{schema='intentarc.client-portability-job/v1';pid=$PID;startTime=$ticks.ToString();jobName=$jobName;runId=$runId;sessionId=$sessionId;nonce=$nonce}|ConvertTo-Json -Compress
  [Console]::Out.WriteLine($bootstrap); [Console]::Out.Flush()
  & $node $bundle '--supervisor' '--job-name' $jobName
  exit $LASTEXITCODE
} finally {
  [Runtime.InteropServices.Marshal]::FreeHGlobal($info)
  [void]$native::CloseHandle($job)
}
`.trim();

const encoded = (value: string): string => Buffer.from(value, "utf8").toString("base64");

export const createWindowsSupervisorJobHostLaunch = (input: {
  readonly nodeExecutable: string;
  readonly supervisorBundle: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly nonce: string;
  readonly repositoryRoot?: string;
  readonly settingsRoot?: string;
  readonly acceptanceRoot?: string;
}): WindowsSupervisorJobHostLaunch => {
  if (
    process.platform !== "win32"
    || !UUID_PATTERN.test(input.runId)
    || !SESSION_PATTERN.test(input.sessionId)
    || !NONCE_PATTERN.test(input.nonce)
  ) throw new Error(INVALID_LAUNCH_MESSAGE);
  const executable = exactWindowsSystemExecutable(
    win32.join("WindowsPowerShell", "v1.0", "powershell.exe"),
  );
  const marker = `${win32.sep}System32${win32.sep}`;
  const markerIndex = executable.toLowerCase().lastIndexOf(marker.toLowerCase());
  if (markerIndex <= 0) throw new Error(INVALID_LAUNCH_MESSAGE);
  const trustedSystemRoot = executable.slice(0, markerIndex);
  const trustedSystem32 = win32.join(trustedSystemRoot, "System32");
  const trustedComSpec = exactWindowsSystemExecutable("cmd.exe");
  const privateRoot = input.acceptanceRoot ?? input.repositoryRoot ?? resolve(".");
  const settingsRoot = input.settingsRoot ?? win32.join(privateRoot, "Roaming", "IntentArc");
  const drive = win32.parse(privateRoot).root.replace(/[\\/]$/, "");
  const homePath = privateRoot.slice(drive.length) || win32.sep;
  const jobName = `Local\\IntentArcPortability-${randomBytes(32).toString("hex")}`;
  return Object.freeze({
    executable,
    arguments: Object.freeze([
      "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `& { ${JOB_HOST_SCRIPT} }`,
      encoded(input.nodeExecutable), encoded(input.supervisorBundle), encoded(jobName),
      encoded(input.runId), encoded(input.sessionId), encoded(input.nonce),
    ]),
    jobName,
    options: Object.freeze({
      cwd: input.repositoryRoot ?? resolve("."),
      env: Object.freeze({
        APPDATA: win32.dirname(settingsRoot),
        ComSpec: trustedComSpec,
        HOMEDRIVE: drive,
        HOMEPATH: homePath,
        LOCALAPPDATA: privateRoot,
        PATH: [win32.dirname(input.nodeExecutable), trustedSystem32, win32.dirname(executable)].join(";"),
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
        PROCESSOR_ARCHITECTURE: process.arch === "arm64" ? "ARM64" : "AMD64",
        PROGRAMFILES: win32.join(win32.parse(trustedSystemRoot).root, "Program Files"),
        SYSTEMDRIVE: win32.parse(trustedSystemRoot).root.replace(/[\\/]$/, ""),
        SystemRoot: trustedSystemRoot,
        TEMP: privateRoot,
        TMP: privateRoot,
        USERNAME: "IntentArc",
        USERPROFILE: privateRoot,
        WINDIR: trustedSystemRoot,
      }),
      shell: false as const,
      windowsHide: true as const,
      stdio: Object.freeze(["pipe", "pipe", "pipe"] as const),
    }),
  });
};

export const parseWindowsSupervisorJobBootstrap = (
  line: string,
  expected: WindowsSupervisorJobBootstrapExpectation,
): SupervisorProcessIdentity | undefined => {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (
      JSON.stringify(value) !== line
      || Object.keys(value).join(",") !== "schema,pid,startTime,jobName,runId,sessionId,nonce"
      || value.schema !== "intentarc.client-portability-job/v1"
      || value.pid !== expected.pid
      || (expected.startTime !== undefined && value.startTime !== expected.startTime)
      || value.jobName !== expected.jobName
      || value.runId !== expected.runId
      || value.sessionId !== expected.sessionId
      || value.nonce !== expected.nonce
      || !Number.isSafeInteger(value.pid)
      || (value.pid as number) <= 0
      || typeof value.startTime !== "string"
      || !/^\d+$/.test(value.startTime)
      || !JOB_NAME_PATTERN.test(expected.jobName)
    ) return undefined;
    return Object.freeze({ pid: value.pid as number, startTime: value.startTime });
  } catch {
    return undefined;
  }
};

const JOB_MEMBER_SCRIPT = String.raw`
& {
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class IntentArcJobMemberProbe {
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern IntPtr OpenJobObject(uint access,bool inherit,string name);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool GetProcessTimes(IntPtr process,out long creation,out long exit,out long kernel,out long user);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool member);
 [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
}
'@
$pidValue=[uint32]::Parse($args[0]); $jobName=$args[1]
$job=[IntentArcJobMemberProbe]::OpenJobObject(4,$false,$jobName)
if ($job -eq [IntPtr]::Zero) { exit 3 }
$process=[IntentArcJobMemberProbe]::OpenProcess(0x1000,$false,$pidValue)
if ($process -eq [IntPtr]::Zero) { [void][IntentArcJobMemberProbe]::CloseHandle($job); exit 3 }
try {
 [long]$creation=0;[long]$exit=0;[long]$kernel=0;[long]$user=0;[bool]$member=$false
 if (-not [IntentArcJobMemberProbe]::GetProcessTimes($process,[ref]$creation,[ref]$exit,[ref]$kernel,[ref]$user)) { exit 3 }
 if (-not [IntentArcJobMemberProbe]::IsProcessInJob($process,$job,[ref]$member)) { exit 3 }
 $ticks=([DateTime]::FromFileTimeUtc($creation)).Ticks;$ticks=$ticks-($ticks%10)
 [ordered]@{pid=[int]$pidValue;startTime=$ticks.ToString();jobMember=$member}|ConvertTo-Json -Compress
} finally { [void][IntentArcJobMemberProbe]::CloseHandle($process);[void][IntentArcJobMemberProbe]::CloseHandle($job) }
}
`.trim();

const productionJobMemberDependencies: WindowsJobMemberObserverDependencies = {
  platform: process.platform,
  inspectMember: (pid, jobName, deadline) => new Promise((resolveInspection) => {
    if (Date.now() >= deadline) { resolveInspection(undefined); return; }
    let executable: string;
    try {
      executable = exactWindowsSystemExecutable(
        win32.join("WindowsPowerShell", "v1.0", "powershell.exe"),
      );
    } catch { resolveInspection(undefined); return; }
    const marker = `${win32.sep}System32${win32.sep}`;
    const index = executable.toLowerCase().lastIndexOf(marker.toLowerCase());
    const trustedSystemRoot = executable.slice(0, index);
    execFile(executable, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      JOB_MEMBER_SCRIPT, String(pid), jobName,
    ], {
      encoding: "utf8",
      maxBuffer: 4096,
      timeout: Math.max(1, Math.min(2_000, deadline - Date.now())),
      windowsHide: true,
      env: { SystemRoot: trustedSystemRoot, WINDIR: trustedSystemRoot },
    }, (error, stdout) => {
      if (error !== null) { resolveInspection(undefined); return; }
      try {
        const value = JSON.parse(stdout.trim()) as WindowsJobMemberInspection;
        resolveInspection(value);
      } catch { resolveInspection(undefined); }
    });
  }),
};

export const observeWindowsJobMemberIdentity = async (
  pid: number,
  jobName: string,
  deadline: number,
  dependencies: WindowsJobMemberObserverDependencies = productionJobMemberDependencies,
): Promise<SupervisorProcessIdentity | undefined> => {
  if (
    dependencies.platform !== "win32"
    || !Number.isSafeInteger(pid)
    || pid <= 0
    || !JOB_NAME_PATTERN.test(jobName)
    || !Number.isFinite(deadline)
    || deadline <= Date.now()
  ) return undefined;
  try {
    const value = await dependencies.inspectMember(pid, jobName, deadline);
    if (
      value === undefined
      || value.pid !== pid
      || !Number.isSafeInteger(value.pid)
      || !/^\d+$/.test(value.startTime)
      || value.jobMember !== true
    ) return undefined;
    return Object.freeze({ pid, startTime: value.startTime });
  } catch {
    return undefined;
  }
};
