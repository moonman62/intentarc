import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { hostname as systemHostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { DurabilityError } from "./errors.js";
import { canonicalDatabasePath } from "./filesystem-identity.js";

export interface LeaseHandle {
  readonly id: string;
  readonly kind: "active" | "maintenance";
  release(): void;
}

export interface LeaseManager {
  acquireActive(databasePath: string): LeaseHandle;
  acquireMaintenance(databasePath: string): LeaseHandle;
  handoffMaintenanceToActive(
    databasePath: string,
    maintenance: LeaseHandle,
  ): LeaseHandle;
}

export interface LeaseManagerOptions {
  nowMs?: () => number;
  newId?: () => string;
  pid?: number;
  hostname?: string;
  heartbeatMs?: number;
  staleMs?: number;
  isProcessAlive?: (pid: number) => boolean | "unknown";
  getProcessStartedAtMs?: (pid: number) => number | "unknown";
}

type LeaseKind = LeaseHandle["kind"];

type LeaseMetadata = {
  formatVersion: 1;
  leaseId: string;
  kind: LeaseKind;
  hostname: string;
  pid: number;
  heartbeatAt: number;
};

type LeasePaths = {
  root: string;
  active: string;
  maintenance: string;
};

type OwnedLeaseState = {
  readonly path: string;
  readonly metadata: LeaseMetadata;
  readonly timer: NodeJS.Timeout;
  released: boolean;
};

const leaseMetadataKeys = [
  "formatVersion",
  "heartbeatAt",
  "hostname",
  "kind",
  "leaseId",
  "pid",
] as const;

const leaseIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const WINDOWS_PROCESS_START_TIMEOUT_MS = 2_000;
export const WINDOWS_PROCESS_START_SCRIPT =
  "& { param([int]$TargetProcessId) " +
  "$startedAt = $null; " +
  "try { " +
  "$target = Get-Process -Id $TargetProcessId -ErrorAction Stop; " +
  "$startedAt = $target.StartTime " +
  "} catch {} " +
  "if ($null -eq $startedAt) { " +
  "try { " +
  "$target = Get-CimInstance -ClassName Win32_Process " +
  "-Filter ('ProcessId = {0}' -f $TargetProcessId) -ErrorAction Stop; " +
  "$startedAt = $target.CreationDate " +
  "} catch {} " +
  "} " +
  "if ($null -eq $startedAt) { exit 1 }; " +
  "([DateTimeOffset]$startedAt).ToUnixTimeMilliseconds() }";
const WINDOWS_PROCESS_EXISTS_SCRIPT =
  "& { param([int]$TargetProcessId) " +
  "try { " +
  "$target = Get-CimInstance -ClassName Win32_Process " +
  "-Filter ('ProcessId = {0}' -f $TargetProcessId) -ErrorAction Stop; " +
  "if ($null -eq $target) { 'missing' } else { 'alive' } " +
  "} catch { exit 1 } " +
  "}";

const conflict = (): never => {
  throw new DurabilityError("maintenance_conflict");
};

const hasErrorCode = (error: unknown, code: string): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: unknown }).code === code;

const defaultWindowsProcessExists = (
  pid: number,
): boolean | "unknown" => {
  if (
    process.platform !== "win32" ||
    !Number.isInteger(pid) ||
    pid <= 0
  ) {
    return "unknown";
  }

  try {
    const serialized = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        WINDOWS_PROCESS_EXISTS_SCRIPT,
        String(pid),
      ],
      {
        encoding: "utf8",
        maxBuffer: 1_024,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: WINDOWS_PROCESS_START_TIMEOUT_MS,
        windowsHide: true,
      },
    ).trim();
    if (serialized === "alive") return true;
    if (serialized === "missing") return false;
    return "unknown";
  } catch {
    return "unknown";
  }
};

const defaultIsProcessAlive = (pid: number): boolean | "unknown" => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ESRCH")) return false;
    return hasErrorCode(error, "EPERM")
      ? defaultWindowsProcessExists(pid)
      : "unknown";
  }
};

const defaultGetProcessStartedAtMs = (
  pid: number,
): number | "unknown" => {
  if (
    process.platform !== "win32" ||
    !Number.isInteger(pid) ||
    pid <= 0
  ) {
    return "unknown";
  }

  try {
    const serialized = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        WINDOWS_PROCESS_START_SCRIPT,
        String(pid),
      ],
      {
        encoding: "utf8",
        maxBuffer: 1_024,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: WINDOWS_PROCESS_START_TIMEOUT_MS,
        windowsHide: true,
      },
    ).trim();
    if (!/^\d+$/.test(serialized)) return "unknown";
    const startedAt = Number(serialized);
    return Number.isSafeInteger(startedAt) && startedAt >= 0
      ? startedAt
      : "unknown";
  } catch {
    return "unknown";
  }
};

const pathsFor = (databasePath: string): LeasePaths => {
  const root = `${databasePath}.intentarc-lock`;
  return {
    root,
    active: join(root, "active"),
    maintenance: join(root, "maintenance.json"),
  };
};

const parseLeaseMetadata = (
  serialized: string,
  expectedKind: LeaseKind,
): LeaseMetadata => {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    return conflict();
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return conflict();
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== leaseMetadataKeys.length ||
    keys.some((key, index) => key !== leaseMetadataKeys[index])
  ) {
    return conflict();
  }

  if (
    record.formatVersion !== 1 ||
    record.kind !== expectedKind ||
    typeof record.leaseId !== "string" ||
    !leaseIdPattern.test(record.leaseId) ||
    typeof record.hostname !== "string" ||
    record.hostname.length === 0 ||
    typeof record.pid !== "number" ||
    !Number.isInteger(record.pid) ||
    record.pid <= 0 ||
    typeof record.heartbeatAt !== "number" ||
    !Number.isFinite(record.heartbeatAt) ||
    record.heartbeatAt < 0
  ) {
    return conflict();
  }

  return {
    formatVersion: 1,
    leaseId: record.leaseId,
    kind: expectedKind,
    hostname: record.hostname,
    pid: record.pid,
    heartbeatAt: record.heartbeatAt,
  };
};

const readLease = (
  path: string,
  expectedKind: LeaseKind,
): LeaseMetadata | undefined => {
  try {
    return parseLeaseMetadata(readFileSync(path, "utf8"), expectedKind);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return undefined;
    if (error instanceof DurabilityError) throw error;
    return conflict();
  }
};

const serializeLease = (metadata: LeaseMetadata): string =>
  JSON.stringify(metadata);

const createLeaseFile = (path: string, metadata: LeaseMetadata): void => {
  try {
    writeFileSync(path, serializeLease(metadata), {
      encoding: "utf8",
      flag: "wx",
    });
  } catch {
    conflict();
  }
};

const removeOwnedLease = (
  path: string,
  kind: LeaseKind,
  leaseId: string,
): boolean => {
  let current: LeaseMetadata | undefined;
  try {
    current = readLease(path, kind);
  } catch {
    return false;
  }
  if (current === undefined) return true;
  if (current.leaseId !== leaseId) return false;

  try {
    rmSync(path);
    return true;
  } catch (error) {
    return hasErrorCode(error, "ENOENT");
  }
};

const refreshOwnedLease = (
  path: string,
  original: LeaseMetadata,
  nowMs: () => number,
): void => {
  let current: LeaseMetadata | undefined;
  try {
    current = readLease(path, original.kind);
  } catch {
    return;
  }
  if (current?.leaseId !== original.leaseId) return;

  const heartbeatAt = nowMs();
  if (!Number.isFinite(heartbeatAt) || heartbeatAt < 0) return;

  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(
      temporaryPath,
      serializeLease({ ...original, heartbeatAt }),
      { encoding: "utf8", flag: "wx" },
    );
    renameSync(temporaryPath, path);
  } catch {
    try {
      rmSync(temporaryPath, { force: true });
    } catch {
      // A failed heartbeat remains fail-safe because the old lease stays put.
    }
  }
};

const validateOptions = (
  pid: number,
  hostname: string,
  heartbeatMs: number,
  staleMs: number,
): void => {
  if (
    !Number.isInteger(pid) ||
    pid <= 0 ||
    hostname.length === 0 ||
    !Number.isFinite(heartbeatMs) ||
    heartbeatMs <= 0 ||
    !Number.isFinite(staleMs) ||
    staleMs < 0
  ) {
    conflict();
  }
};

export const createLeaseManager = (
  options: LeaseManagerOptions = {},
): LeaseManager => {
  const nowMs = options.nowMs ?? Date.now;
  const newId = options.newId ?? randomUUID;
  const pid = options.pid ?? process.pid;
  const hostname = options.hostname ?? systemHostname();
  const heartbeatMs = options.heartbeatMs ?? 10_000;
  const staleMs = options.staleMs ?? 120_000;
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const getProcessStartedAtMs =
    options.getProcessStartedAtMs ?? defaultGetProcessStartedAtMs;
  validateOptions(pid, hostname, heartbeatMs, staleMs);
  const ownedHandles = new WeakMap<LeaseHandle, OwnedLeaseState>();

  const preparePaths = (databasePath: string): LeasePaths => {
    let canonicalPath: string;
    try {
      canonicalPath = canonicalDatabasePath(databasePath);
    } catch {
      return conflict();
    }
    const paths = pathsFor(canonicalPath);
    try {
      mkdirSync(paths.active, { recursive: true });
    } catch {
      conflict();
    }
    return paths;
  };

  const isReclaimable = (metadata: LeaseMetadata): boolean => {
    const currentTime = nowMs();
    if (
      !Number.isFinite(currentTime) ||
      currentTime - metadata.heartbeatAt <= staleMs ||
      metadata.hostname !== hostname
    ) {
      return false;
    }

    try {
      const alive = isProcessAlive(metadata.pid);
      if (alive === false) return true;

      const startedAt = getProcessStartedAtMs(metadata.pid);
      return typeof startedAt === "number" &&
        Number.isFinite(startedAt) &&
        startedAt >= 0 &&
        startedAt > metadata.heartbeatAt;
    } catch {
      return false;
    }
  };

  const ensureMaintenanceAbsent = (path: string): void => {
    const maintenance = readLease(path, "maintenance");
    if (maintenance === undefined) return;
    if (
      isReclaimable(maintenance) &&
      removeOwnedLease(path, "maintenance", maintenance.leaseId)
    ) {
      return;
    }
    conflict();
  };

  const claimMaintenance = (
    path: string,
    lease: LeaseMetadata,
  ): void => {
    try {
      writeFileSync(path, serializeLease(lease), {
        encoding: "utf8",
        flag: "wx",
      });
      return;
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) conflict();
    }

    const existing = readLease(path, "maintenance");
    if (
      existing !== undefined &&
      isReclaimable(existing) &&
      removeOwnedLease(path, "maintenance", existing.leaseId)
    ) {
      createLeaseFile(path, lease);
      return;
    }
    conflict();
  };

  const scanActiveLeases = (activePath: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(activePath);
    } catch {
      return conflict();
    }

    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const path = join(activePath, entry);
      const lease = readLease(path, "active");
      if (
        lease === undefined ||
        entry !== `${lease.leaseId}.json` ||
        !isReclaimable(lease) ||
        !removeOwnedLease(path, "active", lease.leaseId)
      ) {
        conflict();
      }
    }
  };

  const releaseOwnedState = (
    state: OwnedLeaseState,
    finalizeOnFailure = true,
  ): boolean => {
    if (state.released) return true;
    const removed = removeOwnedLease(
      state.path,
      state.metadata.kind,
      state.metadata.leaseId,
    );
    if (removed || finalizeOnFailure) {
      state.released = true;
      clearInterval(state.timer);
    }
    return removed;
  };

  const handleFor = (
    path: string,
    metadata: LeaseMetadata,
  ): LeaseHandle => {
    const timer = setInterval(() => {
      refreshOwnedLease(path, metadata, nowMs);
    }, heartbeatMs);
    timer.unref();
    const handle: LeaseHandle = {
      id: metadata.leaseId,
      kind: metadata.kind,
      release() {
        const state = ownedHandles.get(handle);
        if (state !== undefined) releaseOwnedState(state);
      },
    };
    ownedHandles.set(handle, {
      path,
      metadata,
      timer,
      released: false,
    });
    return handle;
  };

  const newMetadata = (
    leaseId: string,
    kind: LeaseKind,
  ): LeaseMetadata => {
    const heartbeatAt = nowMs();
    if (
      !leaseIdPattern.test(leaseId) ||
      !Number.isFinite(heartbeatAt) ||
      heartbeatAt < 0
    ) {
      conflict();
    }
    return {
      formatVersion: 1,
      leaseId,
      kind,
      hostname,
      pid,
      heartbeatAt,
    };
  };

  return {
    acquireActive(databasePath) {
      const paths = preparePaths(databasePath);
      ensureMaintenanceAbsent(paths.maintenance);
      const lease = newMetadata(newId(), "active");
      const path = join(paths.active, `${lease.leaseId}.json`);
      createLeaseFile(path, lease);
      try {
        ensureMaintenanceAbsent(paths.maintenance);
      } catch {
        removeOwnedLease(path, "active", lease.leaseId);
        conflict();
      }
      return handleFor(path, lease);
    },

    acquireMaintenance(databasePath) {
      const paths = preparePaths(databasePath);
      const lease = newMetadata(newId(), "maintenance");
      claimMaintenance(paths.maintenance, lease);
      try {
        scanActiveLeases(paths.active);
      } catch {
        removeOwnedLease(paths.maintenance, "maintenance", lease.leaseId);
        conflict();
      }
      return handleFor(paths.maintenance, lease);
    },

    handoffMaintenanceToActive(databasePath, maintenance) {
      const paths = preparePaths(databasePath);
      const maintenanceState = ownedHandles.get(maintenance);
      if (maintenanceState === undefined) {
        throw new DurabilityError("maintenance_conflict");
      }
      if (
        maintenanceState.released ||
        maintenanceState.metadata.kind !== "maintenance" ||
        maintenanceState.path !== paths.maintenance
      ) {
        conflict();
      }

      const current = readLease(paths.maintenance, "maintenance");
      if (
        current === undefined ||
        current.leaseId !== maintenanceState.metadata.leaseId
      ) {
        conflict();
      }

      const active = newMetadata(newId(), "active");
      const activePath = join(paths.active, `${active.leaseId}.json`);
      createLeaseFile(activePath, active);
      if (!releaseOwnedState(maintenanceState, false)) {
        removeOwnedLease(activePath, "active", active.leaseId);
        conflict();
      }
      return handleFor(activePath, active);
    },
  };
};
