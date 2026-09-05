import { spawn } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { win32 } from "node:path";
import type { Readable } from "node:stream";
import {
  registerSupervisorHelperLifecycleOwner,
  type SupervisorProcessIdentity,
  type SupervisorSettlementBackend,
  type SupervisorSettlementInput,
  type SupervisorSettlementResult,
} from "./client-portability-supervisor-client.js";

export interface WindowsProcessRow extends SupervisorProcessIdentity {
  readonly parentPid: number;
}

export interface WindowsTerminationResult {
  readonly status: "terminated" | "identity_mismatch" | "unavailable" | "failed";
}

export interface WindowsIdentityProbeResult {
  readonly status: "present" | "absent" | "identity_mismatch" | "unavailable" | "failed";
}

export interface WindowsSettlementDependencies {
  readonly platform: NodeJS.Platform;
  readonly pollIntervalMs: number;
  observeProcessTree(deadline: number): Promise<readonly WindowsProcessRow[]>;
  terminateProcessTree(
    identity: SupervisorProcessIdentity,
    deadline: number,
  ): Promise<WindowsTerminationResult>;
  probeProcessIdentity(
    identity: SupervisorProcessIdentity,
    deadline: number,
  ): Promise<WindowsIdentityProbeResult>;
}

interface WindowsCommandChild {
  readonly pid?: number;
  readonly stdout: Readable;
  readonly stderr: Readable;
  kill(): boolean;
  on(event: "error", listener: () => void): this;
  on(event: "exit", listener: (exitCode: number | null) => void): this;
  on(event: "close", listener: (exitCode: number | null) => void): this;
  once(event: "error", listener: () => void): this;
  removeListener(event: "exit" | "close" | "error", listener: (...args: never[]) => void): this;
}

export interface WindowsCommandRunnerDependencies {
  spawnCommand(
    executable: string,
    arguments_: readonly string[],
    options: {
      readonly shell: false;
      readonly windowsHide: true;
      readonly stdio: readonly ["ignore", "pipe", "pipe"];
      readonly env: Readonly<{ readonly SystemRoot: string; readonly WINDIR: string }>;
    },
  ): WindowsCommandChild;
  readonly cleanupReserveMs: number;
}

export interface WindowsCommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
}

export interface WindowsIdentityObservationDependencies {
  readonly platform: NodeJS.Platform;
  observeProcessTree(deadline: number): Promise<readonly WindowsProcessRow[]>;
}

type DeadlineOutcome<Value> =
  | { readonly kind: "resolved"; readonly value: Value }
  | { readonly kind: "rejected" }
  | { readonly kind: "deadline" };

type SnapshotOutcome =
  | { readonly kind: "accepted"; readonly rows: readonly WindowsProcessRow[] }
  | { readonly kind: "identity" }
  | { readonly kind: "observation" }
  | { readonly kind: "deadline" };

const MAX_SNAPSHOT_ROWS = 4_096;
const MAX_RETAINED_IDENTITIES = 256;
const OBSERVATION_OUTPUT_CAP_BYTES = 512 * 1024;
const TERMINATION_OUTPUT_CAP_BYTES = 64 * 1024;
const DEFAULT_POLL_INTERVAL_MS = 25;
const DEFAULT_HELPER_CLEANUP_RESERVE_MS = 250;
const HELPER_FAILURE_MESSAGE = "Windows helper failed.";
const WINDOWS_SYSTEM32_BOUNDARY = "\\\\?\\GLOBALROOT\\SystemRoot\\System32";
const nativePromiseThen = Promise.prototype.then;
const nativeReflectApply = Reflect.apply;
const windowsHelperLifecycleOwners = new WeakSet<object>();

export const registerWindowsHelperLifecycleOwner = <Owner extends object>(
  owner: Owner,
): Owner => {
  windowsHelperLifecycleOwners.add(owner);
  return owner;
};

const ownsWindowsHelperLifecycle = (value: object): boolean =>
  windowsHelperLifecycleOwners.has(value);

const HANDLE_TERMINATION_SCRIPT = String.raw`
& {
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class IntentArcExactProcessTermination {
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);
  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool TerminateProcess(IntPtr process, uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool CloseHandle(IntPtr handle);
}
'@
$pidValue = [uint32]::Parse($args[0], [Globalization.CultureInfo]::InvariantCulture)
$expectedTicks = [int64]::Parse($args[1], [Globalization.CultureInfo]::InvariantCulture)
$handle = [IntentArcExactProcessTermination]::OpenProcess(0x101001, $false, $pidValue)
if ($handle -eq [IntPtr]::Zero) { [Console]::Out.Write('unavailable'); exit 3 }
try {
  [long]$creation = 0; [long]$exit = 0; [long]$kernel = 0; [long]$user = 0
  if (-not [IntentArcExactProcessTermination]::GetProcessTimes($handle, [ref]$creation, [ref]$exit, [ref]$kernel, [ref]$user)) { [Console]::Out.Write('unavailable'); exit 3 }
  $rawTicks = ([DateTime]::FromFileTimeUtc($creation)).Ticks
  $actualTicks = $rawTicks - ($rawTicks % 10)
  if ($actualTicks -ne $expectedTicks) { [Console]::Out.Write('identity_mismatch'); exit 5 }
  if (-not [IntentArcExactProcessTermination]::TerminateProcess($handle, 1)) { [Console]::Out.Write('failed'); exit 6 }
  if ([IntentArcExactProcessTermination]::WaitForSingleObject($handle, 5000) -ne 0) { [Console]::Out.Write('failed'); exit 6 }
  [Console]::Out.Write('terminated'); exit 0
} catch {
  [Console]::Out.Write('failed'); exit 6
} finally {
  [void][IntentArcExactProcessTermination]::CloseHandle($handle)
}
}
`.trim();

const HANDLE_IDENTITY_PROBE_SCRIPT = String.raw`
& {
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class IntentArcExactProcessProbe {
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);
  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool CloseHandle(IntPtr handle);
}
'@
$pidValue = [uint32]::Parse($args[0], [Globalization.CultureInfo]::InvariantCulture)
$expectedTicks = [int64]::Parse($args[1], [Globalization.CultureInfo]::InvariantCulture)
$handle = [IntentArcExactProcessProbe]::OpenProcess(0x101000, $false, $pidValue)
$openError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
if ($handle -eq [IntPtr]::Zero) {
  if ($openError -eq 87) { [Console]::Out.Write('absent'); exit 0 }
  [Console]::Out.Write('unavailable'); exit 3
}
try {
  [long]$creation = 0; [long]$exit = 0; [long]$kernel = 0; [long]$user = 0
  if (-not [IntentArcExactProcessProbe]::GetProcessTimes($handle, [ref]$creation, [ref]$exit, [ref]$kernel, [ref]$user)) { [Console]::Out.Write('unavailable'); exit 3 }
  $rawTicks = ([DateTime]::FromFileTimeUtc($creation)).Ticks
  $actualTicks = $rawTicks - ($rawTicks % 10)
  if ($actualTicks -ne $expectedTicks) { [Console]::Out.Write('identity_mismatch'); exit 5 }
  $waitStatus = [IntentArcExactProcessProbe]::WaitForSingleObject($handle, 0)
  if ($waitStatus -eq 0) { [Console]::Out.Write('absent'); exit 0 }
  if ($waitStatus -eq 258) { [Console]::Out.Write('present'); exit 4 }
  [Console]::Out.Write('failed'); exit 6
} catch {
  [Console]::Out.Write('failed'); exit 6
} finally {
  [void][IntentArcExactProcessProbe]::CloseHandle($handle)
}
}
`.trim();

const frozenResult = (
  status: SupervisorSettlementResult["status"],
  category: SupervisorSettlementResult["category"],
  retained: readonly SupervisorProcessIdentity[],
): SupervisorSettlementResult => Object.freeze({
  status,
  category,
  retained: Object.freeze(retained.map((identity) => Object.freeze({ ...identity }))),
});

const exactIdentity = (value: SupervisorProcessIdentity | undefined): boolean =>
  value !== undefined
  && Number.isSafeInteger(value.pid)
  && value.pid > 0
  && /^\d+$/.test(value.startTime);

const waitUntilDeadline = <Value>(
  promise: Promise<Value>,
  deadline: number,
): Promise<DeadlineOutcome<Value>> => new Promise((resolveOutcome) => {
  let finished = false;
  let timer: NodeJS.Timeout | undefined;
  const finish = (outcome: DeadlineOutcome<Value>): void => {
    if (finished) return;
    finished = true;
    if (timer !== undefined) clearTimeout(timer);
    resolveOutcome(outcome);
  };
  const remaining = deadline - Date.now();
  if (!Number.isFinite(deadline) || remaining <= 0) {
    finish({ kind: "deadline" });
    return;
  }
  timer = setTimeout(() => finish({ kind: "deadline" }), Math.min(remaining, 2_147_483_647));
  nativeReflectApply(nativePromiseThen, promise, [
    (value: Value) => finish({ kind: "resolved", value }),
    () => finish({ kind: "rejected" }),
  ]);
});

const waitForOwnedLifecycle = <Value>(
  promise: Promise<Value>,
): Promise<Exclude<DeadlineOutcome<Value>, { readonly kind: "deadline" }>> => new Promise((
  resolveOutcome,
) => {
  nativeReflectApply(nativePromiseThen, promise, [
    (value: Value) => resolveOutcome({ kind: "resolved", value }),
    () => resolveOutcome({ kind: "rejected" }),
  ]);
});

const waitForPoll = (
  milliseconds: number,
  deadline: number,
): Promise<"poll" | "deadline"> => new Promise((resolveWait) => {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    resolveWait("deadline");
    return;
  }
  const delay = Math.min(milliseconds, remaining);
  setTimeout(() => resolveWait(delay >= remaining ? "deadline" : "poll"), delay);
});

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

const spawnWindowsCommand: WindowsCommandRunnerDependencies["spawnCommand"] = (
  executable,
  arguments_,
  options,
) => spawn(
    executable,
    [...arguments_],
    {
      shell: options.shell,
      windowsHide: options.windowsHide,
      stdio: [...options.stdio],
      env: { ...options.env },
    },
  ) as unknown as WindowsCommandChild;

const defaultCommandRunner: WindowsCommandRunnerDependencies = Object.freeze({
  spawnCommand: spawnWindowsCommand,
  cleanupReserveMs: DEFAULT_HELPER_CLEANUP_RESERVE_MS,
});

export const runBoundedWindowsCommand = (
  executable: string,
  arguments_: readonly string[],
  deadline: number,
  maximumOutputBytes: number,
  dependencies: WindowsCommandRunnerDependencies = defaultCommandRunner,
): Promise<WindowsCommandResult> => new Promise((resolveCommand, rejectCommand) => {
  const remaining = deadline - Date.now();
  const system32Marker = `${win32.sep}System32${win32.sep}`;
  const system32Index = executable.toLowerCase().lastIndexOf(system32Marker.toLowerCase());
  const trustedSystemRoot = system32Index > 0 ? executable.slice(0, system32Index) : undefined;
  if (
    !Number.isFinite(deadline)
    || remaining <= 0
    || !Number.isSafeInteger(maximumOutputBytes)
    || maximumOutputBytes <= 0
    || !Number.isFinite(dependencies.cleanupReserveMs)
    || dependencies.cleanupReserveMs < 0
    || trustedSystemRoot === undefined
    || !win32.isAbsolute(trustedSystemRoot)
  ) {
    rejectCommand(new Error(HELPER_FAILURE_MESSAGE));
    return;
  }
  let child: WindowsCommandChild;
  try {
    child = dependencies.spawnCommand(executable, arguments_, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: Object.freeze({ SystemRoot: trustedSystemRoot, WINDIR: trustedSystemRoot }),
    });
  } catch {
    rejectCommand(new Error(HELPER_FAILURE_MESSAGE));
    return;
  }
  let settled = false;
  let failing = false;
  let sawExit = false;
  let sawClose = false;
  let spawnFailedWithoutProcess = false;
  let exitCode: number | null = null;
  let outputBytes = 0;
  const stdout: Buffer[] = [];
  let operationTimer: NodeJS.Timeout | undefined;
  let hardDeadlineTimer: NodeJS.Timeout | undefined;
  const clearTimers = (): void => {
    if (operationTimer !== undefined) clearTimeout(operationTimer);
    if (hardDeadlineTimer !== undefined) clearTimeout(hardDeadlineTimer);
  };
  const readStdout = (chunk: Buffer): void => consume(chunk, true);
  const readStderr = (chunk: Buffer): void => consume(chunk, false);
  const onError = (): void => {
    try { spawnFailedWithoutProcess = child.pid === undefined; }
    catch { spawnFailedWithoutProcess = false; }
    beginFailureCleanup();
  };
  const onExit = (code: number | null): void => {
    sawExit = true;
    exitCode = code;
    finish();
  };
  const onClose = (code: number | null): void => {
    sawClose = true;
    if (!sawExit) exitCode = code;
    finish();
  };
  const consumeLateError = (): void => undefined;
  const detach = (ownLateErrors = false): void => {
    child.stdout.removeListener("data", readStdout);
    child.stderr.removeListener("data", readStderr);
    child.removeListener("error", onError as (...args: never[]) => void);
    child.removeListener("exit", onExit as (...args: never[]) => void);
    child.removeListener("close", onClose as (...args: never[]) => void);
    if (ownLateErrors) child.on("error", consumeLateError);
  };
  const finish = (): void => {
    if (settled || !sawClose || (!sawExit && !spawnFailedWithoutProcess)) return;
    settled = true;
    clearTimers();
    detach();
    if (failing) rejectCommand(new Error(HELPER_FAILURE_MESSAGE));
    else resolveCommand({ exitCode, stdout: Buffer.concat(stdout).toString("utf8") });
  };
  const beginFailureCleanup = (): void => {
    if (settled || failing) return;
    failing = true;
    if (operationTimer !== undefined) clearTimeout(operationTimer);
    try { child.kill(); } catch { /* The command boundary is already failed closed. */ }
    try { child.stdout.destroy(); } catch { /* The pipe already closed. */ }
    try { child.stderr.destroy(); } catch { /* The pipe already closed. */ }
    finish();
  };
  const consume = (chunk: Buffer, retain: boolean): void => {
    if (settled || failing) return;
    outputBytes += chunk.byteLength;
    if (outputBytes > maximumOutputBytes) {
      beginFailureCleanup();
      return;
    }
    if (retain) stdout.push(chunk);
  };
  const hardComplete = (): void => {
    if (settled) return;
    beginFailureCleanup();
    settled = true;
    clearTimers();
    detach(true);
    rejectCommand(new Error(HELPER_FAILURE_MESSAGE));
  };
  child.stdout.on("data", readStdout);
  child.stderr.on("data", readStderr);
  child.once("error", onError);
  child.on("exit", onExit);
  child.on("close", onClose);
  const operationMilliseconds = Math.max(
    0,
    remaining - Math.min(remaining, dependencies.cleanupReserveMs),
  );
  operationTimer = setTimeout(beginFailureCleanup, Math.min(operationMilliseconds, 2_147_483_647));
  hardDeadlineTimer = setTimeout(hardComplete, Math.min(remaining, 2_147_483_647));
});

const structurallyValidatedRows = (
  value: readonly WindowsProcessRow[],
): readonly WindowsProcessRow[] | undefined => {
  if (!Array.isArray(value) || value.length > MAX_SNAPSHOT_ROWS) return undefined;
  const rows: WindowsProcessRow[] = [];
  const seenPids = new Set<number>();
  for (const candidate of value) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      return undefined;
    }
    if (
      !Number.isSafeInteger(candidate.pid)
      || candidate.pid < 0
      || !Number.isSafeInteger(candidate.parentPid)
      || candidate.parentPid < 0
      || typeof candidate.startTime !== "string"
      || !/^\d+$/.test(candidate.startTime)
    ) return undefined;
    if (candidate.pid === 0) continue;
    if (seenPids.has(candidate.pid)) return undefined;
    seenPids.add(candidate.pid);
    rows.push(Object.freeze({
      pid: candidate.pid,
      parentPid: candidate.parentPid,
      startTime: candidate.startTime,
    }));
  }
  return Object.freeze(rows);
};

const observeProductionWindowsProcessTree = async (
  deadline: number,
): Promise<readonly WindowsProcessRow[]> => {
  const powershell = exactWindowsSystemExecutable(
    win32.join("WindowsPowerShell", "v1.0", "powershell.exe"),
  );
  const script = [
    "$ErrorActionPreference='Stop'",
    "$rows=@(Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,CreationDate -OperationTimeoutSec 1 -ErrorAction Stop | ForEach-Object {",
    "  [ordered]@{ pid=[int]$_.ProcessId; parentPid=[int]$_.ParentProcessId; startTime=$_.CreationDate.ToUniversalTime().Ticks.ToString() }",
    "})",
    "[ordered]@{ rows=$rows } | ConvertTo-Json -Compress -Depth 3",
  ].join("; ");
  const result = await runBoundedWindowsCommand(powershell, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script,
  ], deadline, OBSERVATION_OUTPUT_CAP_BYTES);
  if (result.exitCode !== 0) throw new Error("observation");
  let parsed: unknown;
  try { parsed = JSON.parse(result.stdout.trim()); } catch { throw new Error("observation"); }
  if (
    typeof parsed !== "object"
    || parsed === null
    || Array.isArray(parsed)
    || !("rows" in parsed)
    || !Array.isArray(parsed.rows)
  ) throw new Error("observation");
  const rows = structurallyValidatedRows(parsed.rows as readonly WindowsProcessRow[]);
  if (rows === undefined) throw new Error("observation");
  return rows;
};

export const terminateWindowsProcessIdentity = async (
  identity: SupervisorProcessIdentity,
  deadline: number,
): Promise<WindowsTerminationResult> => {
  if (
    process.platform !== "win32"
    || !exactIdentity(identity)
    || !Number.isFinite(deadline)
    || deadline <= Date.now()
  ) return Object.freeze({ status: "unavailable" });
  try {
    const powershell = exactWindowsSystemExecutable(
      win32.join("WindowsPowerShell", "v1.0", "powershell.exe"),
    );
    const result = await runBoundedWindowsCommand(powershell, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      HANDLE_TERMINATION_SCRIPT, String(identity.pid), identity.startTime,
    ], deadline, TERMINATION_OUTPUT_CAP_BYTES);
    const status = result.stdout.trim();
    if (result.exitCode === 0 && status === "terminated") {
      return Object.freeze({ status: "terminated" });
    }
    if (result.exitCode === 5 && status === "identity_mismatch") {
      return Object.freeze({ status: "identity_mismatch" });
    }
    if (result.exitCode === 3 && status === "unavailable") {
      return Object.freeze({ status: "unavailable" });
    }
    return Object.freeze({ status: "failed" });
  } catch {
    return Object.freeze({ status: "failed" });
  }
};

export const probeWindowsProcessIdentity = async (
  identity: SupervisorProcessIdentity,
  deadline: number,
): Promise<WindowsIdentityProbeResult> => {
  if (
    process.platform !== "win32"
    || !exactIdentity(identity)
    || !Number.isFinite(deadline)
    || deadline <= Date.now()
  ) return Object.freeze({ status: "unavailable" });
  try {
    const powershell = exactWindowsSystemExecutable(
      win32.join("WindowsPowerShell", "v1.0", "powershell.exe"),
    );
    const result = await runBoundedWindowsCommand(powershell, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      HANDLE_IDENTITY_PROBE_SCRIPT, String(identity.pid), identity.startTime,
    ], deadline, TERMINATION_OUTPUT_CAP_BYTES);
    const status = result.stdout.trim();
    if (result.exitCode === 0 && status === "absent") {
      return Object.freeze({ status: "absent" });
    }
    if (result.exitCode === 4 && status === "present") {
      return Object.freeze({ status: "present" });
    }
    if (result.exitCode === 5 && status === "identity_mismatch") {
      return Object.freeze({ status: "identity_mismatch" });
    }
    if (result.exitCode === 3 && status === "unavailable") {
      return Object.freeze({ status: "unavailable" });
    }
    return Object.freeze({ status: "failed" });
  } catch {
    return Object.freeze({ status: "failed" });
  }
};

const productionDependencies: WindowsSettlementDependencies = Object.freeze({
  platform: process.platform,
  pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
  observeProcessTree: observeProductionWindowsProcessTree,
  terminateProcessTree: terminateWindowsProcessIdentity,
  probeProcessIdentity: probeWindowsProcessIdentity,
});
registerWindowsHelperLifecycleOwner(productionDependencies);

const productionIdentityObservationDependencies: WindowsIdentityObservationDependencies =
  Object.freeze({
    platform: process.platform,
    observeProcessTree: observeProductionWindowsProcessTree,
  });
registerWindowsHelperLifecycleOwner(productionIdentityObservationDependencies);

export const observeWindowsSupervisorIdentity = async (
  pid: number,
  deadline: number,
  dependencies: WindowsIdentityObservationDependencies = productionIdentityObservationDependencies,
): Promise<SupervisorProcessIdentity | undefined> => {
  if (
    dependencies.platform !== "win32"
    || !Number.isSafeInteger(pid)
    || pid <= 0
    || !Number.isFinite(deadline)
    || deadline <= Date.now()
  ) return undefined;
  try {
    const observation = Promise.resolve(dependencies.observeProcessTree(deadline));
    const outcome = ownsWindowsHelperLifecycle(dependencies)
      ? await waitForOwnedLifecycle(observation)
      : await waitUntilDeadline(observation, deadline);
    if (outcome.kind !== "resolved") return undefined;
    const rows = structurallyValidatedRows(outcome.value);
    if (rows === undefined) return undefined;
    const matches = rows.filter((candidate) => candidate.pid === pid);
    if (matches.length !== 1 || !exactIdentity(matches[0])) return undefined;
    return Object.freeze({ pid, startTime: matches[0]!.startTime });
  } catch {
    return undefined;
  }
};

registerSupervisorHelperLifecycleOwner(observeWindowsSupervisorIdentity);

const retainedValues = (
  roots: ReadonlyMap<number, SupervisorProcessIdentity>,
  retained: ReadonlyMap<number, SupervisorProcessIdentity>,
): readonly SupervisorProcessIdentity[] => [...roots.values(), ...retained.values()];

const validateSnapshot = (
  value: readonly WindowsProcessRow[],
  roots: ReadonlyMap<number, SupervisorProcessIdentity>,
  retained: Map<number, SupervisorProcessIdentity>,
): SnapshotOutcome => {
  const rows = structurallyValidatedRows(value);
  if (rows === undefined) return { kind: "observation" };
  for (const candidate of rows) {
    const recorded = roots.get(candidate.pid) ?? retained.get(candidate.pid);
    if (recorded !== undefined && recorded.startTime !== candidate.startTime) {
      return { kind: "identity" };
    }
  }
  let changed = true;
  const presentPids = new Set(rows.map((candidate) => candidate.pid));
  while (changed) {
    changed = false;
    for (const candidate of rows) {
      if (roots.has(candidate.pid) || retained.has(candidate.pid)) continue;
      if (!roots.has(candidate.parentPid) && !retained.has(candidate.parentPid)) continue;
      if (!presentPids.has(candidate.parentPid)) return { kind: "observation" };
      if (retained.size >= MAX_RETAINED_IDENTITIES) return { kind: "observation" };
      retained.set(candidate.pid, Object.freeze({
        pid: candidate.pid,
        startTime: candidate.startTime,
      }));
      changed = true;
    }
  }
  return { kind: "accepted", rows };
};

const validateFinalDiscoverySnapshot = (
  value: readonly WindowsProcessRow[],
  roots: ReadonlyMap<number, SupervisorProcessIdentity>,
  retained: Map<number, SupervisorProcessIdentity>,
): SnapshotOutcome => {
  const rows = structurallyValidatedRows(value);
  if (rows === undefined) return { kind: "observation" };
  const replacedLineage = new Set<number>();
  for (const candidate of rows) {
    const recorded = roots.get(candidate.pid) ?? retained.get(candidate.pid);
    if (recorded !== undefined && recorded.startTime !== candidate.startTime) {
      replacedLineage.add(candidate.pid);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of rows) {
      if (
        replacedLineage.has(candidate.pid)
        || roots.has(candidate.pid)
        || retained.has(candidate.pid)
        || !replacedLineage.has(candidate.parentPid)
      ) continue;
      replacedLineage.add(candidate.pid);
      changed = true;
    }
  }
  return validateSnapshot(
    rows.filter((candidate) => !replacedLineage.has(candidate.pid)),
    roots,
    retained,
  );
};

const observeValidatedSnapshot = async (
  dependencies: WindowsSettlementDependencies,
  deadline: number,
  roots: ReadonlyMap<number, SupervisorProcessIdentity>,
  retained: Map<number, SupervisorProcessIdentity>,
  validate: (
    value: readonly WindowsProcessRow[],
    roots_: ReadonlyMap<number, SupervisorProcessIdentity>,
    retained_: Map<number, SupervisorProcessIdentity>,
  ) => SnapshotOutcome = validateSnapshot,
): Promise<SnapshotOutcome> => {
  let observation: Promise<readonly WindowsProcessRow[]>;
  try { observation = Promise.resolve(dependencies.observeProcessTree(deadline)); }
  catch { return { kind: "observation" }; }
  const outcome = ownsWindowsHelperLifecycle(dependencies)
    ? await waitForOwnedLifecycle(observation)
    : await waitUntilDeadline(observation, deadline);
  if (outcome.kind === "deadline") return { kind: "deadline" };
  if (outcome.kind === "rejected") return { kind: "observation" };
  try { return validate(outcome.value, roots, retained); }
  catch { return { kind: "observation" }; }
};

const seedIdentity = (
  destination: Map<number, SupervisorProcessIdentity>,
  other: ReadonlyMap<number, SupervisorProcessIdentity>,
  candidate: SupervisorProcessIdentity,
): boolean => {
  if (!exactIdentity(candidate) || other.has(candidate.pid)) return false;
  const existing = destination.get(candidate.pid);
  if (existing !== undefined) return existing.startTime === candidate.startTime;
  destination.set(candidate.pid, Object.freeze({ ...candidate }));
  return true;
};

const resultForSnapshotFailure = (
  outcome: Exclude<SnapshotOutcome, { readonly kind: "accepted" }>,
  roots: ReadonlyMap<number, SupervisorProcessIdentity>,
  retained: ReadonlyMap<number, SupervisorProcessIdentity>,
  activeTermination = false,
): SupervisorSettlementResult => frozenResult(
  "blocked",
  outcome.kind === "deadline"
    ? activeTermination ? "termination" : "observation"
    : outcome.kind,
  retainedValues(roots, retained),
);

const exactTerminationStatus = (value: unknown): WindowsTerminationResult["status"] | undefined => {
  try {
    const status = (value as { readonly status?: unknown })?.status;
    return status === "terminated"
      || status === "identity_mismatch"
      || status === "unavailable"
      || status === "failed"
      ? status
      : undefined;
  } catch { return undefined; }
};

const exactProbeStatus = (value: unknown): WindowsIdentityProbeResult["status"] | undefined => {
  try {
    const status = (value as { readonly status?: unknown })?.status;
    return status === "present"
      || status === "absent"
      || status === "identity_mismatch"
      || status === "unavailable"
      || status === "failed"
      ? status
      : undefined;
  } catch { return undefined; }
};

export const settleWindowsSupervisorProcesses = async (
  input: SupervisorSettlementInput,
  dependencies: WindowsSettlementDependencies = productionDependencies,
): Promise<SupervisorSettlementResult> => {
  if (dependencies.platform !== "win32") {
    return frozenResult("unsupported", "platform", []);
  }
  const roots = new Map<number, SupervisorProcessIdentity>();
  const retained = new Map<number, SupervisorProcessIdentity>();
  let childPid: number | undefined;
  try {
    childPid = input.child.pid;
    if (
      !Number.isSafeInteger(childPid)
      || childPid === undefined
      || childPid <= 0
      || !Number.isFinite(input.deadline)
      || input.retainedIdentities.length > MAX_RETAINED_IDENTITIES
      || !Number.isFinite(dependencies.pollIntervalMs)
      || dependencies.pollIntervalMs <= 0
    ) return frozenResult("blocked", "identity", retainedValues(roots, retained));
    for (const candidate of input.roots) {
      if (!seedIdentity(roots, retained, candidate)) {
        return frozenResult("blocked", "identity", retainedValues(roots, retained));
      }
    }
    for (const candidate of input.retainedIdentities) {
      if (!seedIdentity(retained, roots, candidate)) {
        return frozenResult("blocked", "identity", retainedValues(roots, retained));
      }
    }
    if (input.jobObjectOwned !== true) {
      return frozenResult("blocked", "identity", retainedValues(roots, retained));
    }
  } catch {
    return frozenResult("blocked", "identity", retainedValues(roots, retained));
  }

  const rootOutcome = await waitUntilDeadline(input.rootIdentity, input.deadline);
  if (
    rootOutcome.kind !== "resolved"
    || !exactIdentity(rootOutcome.value)
    || rootOutcome.value.pid !== childPid
    || (roots.size > 0 && (
      roots.size !== 1
      || roots.get(rootOutcome.value.pid)?.startTime !== rootOutcome.value.startTime
    ))
    || (roots.size === 0 && !seedIdentity(roots, retained, rootOutcome.value))
  ) return frozenResult("blocked", "identity", retainedValues(roots, retained));

  const childOutcomePromise = waitUntilDeadline(input.childExitAndClose, input.deadline);
  const finalRetainedOutcomePromise = waitUntilDeadline(
    input.finalRetainedIdentities,
    input.deadline,
  );
  const attempted = new Set<number>();

  const terminateUntilAbsent = async (): Promise<SupervisorSettlementResult | undefined> => {
    while (Date.now() < input.deadline) {
      const snapshot = await observeValidatedSnapshot(dependencies, input.deadline, roots, retained);
      if (snapshot.kind !== "accepted") {
        return resultForSnapshotFailure(snapshot, roots, retained);
      }
      const presentPids = new Set(snapshot.rows.map((candidate) => candidate.pid));
      const alive = retainedValues(roots, retained).filter((identity) => presentPids.has(identity.pid));
      const candidate = alive.find((identity) => !attempted.has(identity.pid));
      if (candidate === undefined) {
        if (alive.length === 0) return undefined;
        if (await waitForPoll(dependencies.pollIntervalMs, input.deadline) === "deadline") {
          return frozenResult("blocked", "termination", retainedValues(roots, retained));
        }
        continue;
      }
      const preTerminationSnapshot = await observeValidatedSnapshot(
        dependencies, input.deadline, roots, retained,
      );
      if (preTerminationSnapshot.kind !== "accepted") {
        return resultForSnapshotFailure(preTerminationSnapshot, roots, retained);
      }
      if (!preTerminationSnapshot.rows.some((row_) => row_.pid === candidate.pid)) {
        continue;
      }
      const immediateActiveSnapshotPromise = observeValidatedSnapshot(
        dependencies, input.deadline, roots, retained,
      );
      attempted.add(candidate.pid);
      let termination: Promise<WindowsTerminationResult>;
      try {
        termination = Promise.resolve(dependencies.terminateProcessTree(candidate, input.deadline));
      } catch {
        return frozenResult("blocked", "termination", retainedValues(roots, retained));
      }
      let terminationFinished = false;
      const terminationSignal = new Promise<"termination">((resolveSignal) => {
        nativeReflectApply(nativePromiseThen, termination, [
          () => { terminationFinished = true; resolveSignal("termination"); },
          () => { terminationFinished = true; resolveSignal("termination"); },
        ]);
      });
      const immediateActiveSnapshot = await immediateActiveSnapshotPromise;
      if (immediateActiveSnapshot.kind !== "accepted") {
        const failure = resultForSnapshotFailure(immediateActiveSnapshot, roots, retained, true);
        if (ownsWindowsHelperLifecycle(dependencies)) await terminationSignal;
        return failure;
      }
      while (!terminationFinished) {
        const poll = await Promise.race([
          terminationSignal,
          waitForPoll(dependencies.pollIntervalMs, input.deadline),
        ]);
        if (poll === "termination") break;
        if (poll === "deadline" || Date.now() >= input.deadline) {
          if (ownsWindowsHelperLifecycle(dependencies)) {
            await terminationSignal;
            break;
          }
          return frozenResult("blocked", "termination", retainedValues(roots, retained));
        }
        const activeSnapshot = await observeValidatedSnapshot(
          dependencies, input.deadline, roots, retained,
        );
        if (activeSnapshot.kind !== "accepted") {
          const failure = resultForSnapshotFailure(activeSnapshot, roots, retained, true);
          if (ownsWindowsHelperLifecycle(dependencies)) await terminationSignal;
          return failure;
        }
      }
      const terminationOutcome = ownsWindowsHelperLifecycle(dependencies)
        ? await waitForOwnedLifecycle(termination)
        : await waitUntilDeadline(termination, input.deadline);
      if (terminationOutcome.kind !== "resolved") {
        return frozenResult("blocked", "termination", retainedValues(roots, retained));
      }
      const status = exactTerminationStatus(terminationOutcome.value);
      if (status === "identity_mismatch" || status === "unavailable") {
        return frozenResult("blocked", "identity", retainedValues(roots, retained));
      }
      if (status !== "terminated") {
        return frozenResult("blocked", "termination", retainedValues(roots, retained));
      }
    }
    return frozenResult("blocked", "termination", retainedValues(roots, retained));
  };

  const initialTerminationFailure = await terminateUntilAbsent();
  if (initialTerminationFailure !== undefined) return initialTerminationFailure;

  const finalRetainedOutcome = await finalRetainedOutcomePromise;
  if (finalRetainedOutcome.kind !== "resolved") {
    return frozenResult("blocked", "observation", retainedValues(roots, retained));
  }
  try {
    if (
      !Array.isArray(finalRetainedOutcome.value)
      || finalRetainedOutcome.value.length > MAX_RETAINED_IDENTITIES
    ) {
      return frozenResult("blocked", "identity", retainedValues(roots, retained));
    }
    const combinedRetained = new Map(retained);
    for (const candidate of finalRetainedOutcome.value) {
      if (
        !seedIdentity(combinedRetained, roots, candidate)
        || combinedRetained.size > MAX_RETAINED_IDENTITIES
      ) {
        return frozenResult("blocked", "identity", retainedValues(roots, retained));
      }
    }
    for (const [pid, identity] of combinedRetained) {
      if (!retained.has(pid)) retained.set(pid, identity);
    }
  } catch {
    return frozenResult("blocked", "identity", retainedValues(roots, retained));
  }

  const finalTerminationFailure = await terminateUntilAbsent();
  if (finalTerminationFailure !== undefined) return finalTerminationFailure;

  const childOutcome = await childOutcomePromise;
  if (childOutcome.kind !== "resolved") {
    return frozenResult("blocked", "child_handle", retainedValues(roots, retained));
  }
  const finalSnapshot = await observeValidatedSnapshot(
    dependencies,
    input.deadline,
    roots,
    retained,
    validateFinalDiscoverySnapshot,
  );
  if (finalSnapshot.kind !== "accepted") {
    return resultForSnapshotFailure(finalSnapshot, roots, retained);
  }
  const finalPids = new Set(finalSnapshot.rows.map((candidate) => candidate.pid));
  if (retainedValues(roots, retained).some((identity) => finalPids.has(identity.pid))) {
    return frozenResult("blocked", "termination", retainedValues(roots, retained));
  }
  for (const identity of retainedValues(roots, retained)) {
    let probe: Promise<WindowsIdentityProbeResult>;
    try { probe = Promise.resolve(dependencies.probeProcessIdentity(identity, input.deadline)); }
    catch { return frozenResult("blocked", "observation", retainedValues(roots, retained)); }
    const probeOutcome = ownsWindowsHelperLifecycle(dependencies)
      ? await waitForOwnedLifecycle(probe)
      : await waitUntilDeadline(probe, input.deadline);
    if (Date.now() >= input.deadline || probeOutcome.kind !== "resolved") {
      return frozenResult("blocked", "observation", retainedValues(roots, retained));
    }
    const probeStatus = exactProbeStatus(probeOutcome.value);
    if (probeStatus === "present") {
      return frozenResult("blocked", "termination", retainedValues(roots, retained));
    }
    if (probeStatus !== "absent" && probeStatus !== "identity_mismatch") {
      return frozenResult("blocked", "observation", retainedValues(roots, retained));
    }
  }
  return frozenResult("settled", "none", retainedValues(roots, retained));
};

export const createWindowsSupervisorSettlementBackend = (
  dependencies?: WindowsSettlementDependencies,
): SupervisorSettlementBackend => {
  const backend: SupervisorSettlementBackend = Object.freeze({
    settle: (input: SupervisorSettlementInput) =>
      settleWindowsSupervisorProcesses(input, dependencies),
  });
  return dependencies === undefined || ownsWindowsHelperLifecycle(dependencies)
    ? registerSupervisorHelperLifecycleOwner(backend)
    : backend;
};
