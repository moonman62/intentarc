import { afterEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtempSync } from "node:fs";
import {
  execFileSync,
  spawn,
  type ChildProcess,
} from "node:child_process";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { DurabilityError } from "./errors.js";
import {
  createLeaseManager,
  type LeaseHandle,
  type LeaseManagerOptions,
  WINDOWS_PROCESS_START_SCRIPT,
} from "./leases.js";

type LeaseKind = "active" | "maintenance";

type LeaseMetadata = {
  formatVersion: 1;
  leaseId: string;
  kind: LeaseKind;
  hostname: string;
  pid: number;
  heartbeatAt: number;
};

const fileSymlinksSupported = (): boolean => {
  const directory = mkdtempSync(join(tmpdir(), "intentarc-lease-links-"));
  try {
    const target = join(directory, "target");
    const link = join(directory, "link");
    writeFileSync(target, "");
    symlinkSync(target, link, "file");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

const supportsFileSymlinks = fileSymlinksSupported();

const runProcessStartScript = (script: string, pid: number): string =>
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
      String(pid),
    ],
    {
      encoding: "utf8",
      maxBuffer: 1_024,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
      windowsHide: true,
    },
  ).trim();

describe("cooperative process leases", () => {
  const directories: string[] = [];
  const handles: LeaseHandle[] = [];
  const childProcesses: ChildProcess[] = [];

  afterEach(() => {
    handles.splice(0).reverse().forEach((handle) => handle.release());
    childProcesses.splice(0).forEach((child) => {
      if (child.exitCode === null) child.kill();
    });
    directories.splice(0).forEach((directory) => {
      rmSync(directory, { recursive: true, force: true });
    });
  });

  const fixture = (): string => {
    const directory = mkdtempSync(join(tmpdir(), "intentarc-leases-"));
    directories.push(directory);
    return join(directory, "project.sqlite");
  };

  const pathsFor = (databasePath: string) => {
    const root = `${databasePath}.intentarc-lock`;
    return {
      root,
      active: join(root, "active"),
      maintenance: join(root, "maintenance.json"),
      activeLease: (id: string) => join(root, "active", `${id}.json`),
    };
  };

  const metadata = (
    leaseId: string,
    kind: LeaseKind,
    heartbeatAt: number,
    overrides: Partial<Pick<LeaseMetadata, "hostname" | "pid">> = {},
  ): LeaseMetadata => ({
    formatVersion: 1,
    leaseId,
    kind,
    hostname: "test-host",
    pid: 4242,
    heartbeatAt,
    ...overrides,
  });

  const writeMetadata = (
    path: string,
    document: LeaseMetadata | string,
  ): void => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(
      path,
      typeof document === "string" ? document : JSON.stringify(document),
    );
  };

  const manager = (
    ids: string[],
    overrides: Partial<LeaseManagerOptions> = {},
  ) => createLeaseManager({
    nowMs: () => 1_000_000,
    newId: () => {
      const id = ids.shift();
      if (id === undefined) throw new Error("test lease ID exhausted");
      return id;
    },
    pid: 4242,
    hostname: "test-host",
    heartbeatMs: 60_000,
    staleMs: 120_000,
    isProcessAlive: () => true,
    ...overrides,
  });

  const expectMaintenanceConflict = (operation: () => unknown): void => {
    try {
      operation();
      throw new Error("expected maintenance conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(DurabilityError);
      expect(error).toMatchObject({
        code: "maintenance_conflict",
        message: "Store maintenance is unavailable.",
        details: {},
      });
    }
  };

  it("allows multiple active leases for one database", () => {
    const databasePath = fixture();
    const leaseManager = manager(["active-one", "active-two"]);

    const first = leaseManager.acquireActive(databasePath);
    const second = leaseManager.acquireActive(databasePath);
    handles.push(first, second);

    expect(first).toMatchObject({ id: "active-one", kind: "active" });
    expect(second).toMatchObject({ id: "active-two", kind: "active" });
    expect(JSON.parse(readFileSync(
      pathsFor(databasePath).activeLease("active-one"),
      "utf8",
    ))).toEqual(metadata("active-one", "active", 1_000_000));
    expect(JSON.parse(readFileSync(
      pathsFor(databasePath).activeLease("active-two"),
      "utf8",
    ))).toEqual(metadata("active-two", "active", 1_000_000));
  });

  it("refuses maintenance while a live active lease exists", () => {
    const databasePath = fixture();
    const leaseManager = manager(["active-one", "maintenance-one"]);
    handles.push(leaseManager.acquireActive(databasePath));

    expectMaintenanceConflict(() => {
      leaseManager.acquireMaintenance(databasePath);
    });

    expect(existsSync(pathsFor(databasePath).activeLease("active-one"))).toBe(true);
    expect(existsSync(pathsFor(databasePath).maintenance)).toBe(false);
  });

  it("refuses an active lease while maintenance is held", () => {
    const databasePath = fixture();
    const leaseManager = manager(["maintenance-one", "active-one"]);
    handles.push(leaseManager.acquireMaintenance(databasePath));

    expectMaintenanceConflict(() => {
      leaseManager.acquireActive(databasePath);
    });

    expect(existsSync(pathsFor(databasePath).maintenance)).toBe(true);
    expect(existsSync(pathsFor(databasePath).activeLease("active-one"))).toBe(false);
  });

  it("releases only the file owned by each handle", () => {
    const databasePath = fixture();
    const leaseManager = manager(["active-one", "active-two"]);
    const first = leaseManager.acquireActive(databasePath);
    const second = leaseManager.acquireActive(databasePath);
    const unownedPath = join(pathsFor(databasePath).active, "unowned.note");
    writeFileSync(unownedPath, "keep");

    first.release();

    expect(existsSync(pathsFor(databasePath).activeLease("active-one"))).toBe(false);
    expect(existsSync(pathsFor(databasePath).activeLease("active-two"))).toBe(true);
    expect(existsSync(unownedPath)).toBe(true);

    second.release();
    expect(existsSync(pathsFor(databasePath).activeLease("active-two"))).toBe(false);
    expect(existsSync(unownedPath)).toBe(true);
  });

  it("retains a heartbeat older than 120 seconds when its same-host PID is alive", () => {
    const databasePath = fixture();
    const paths = pathsFor(databasePath);
    writeMetadata(
      paths.activeLease("old-active"),
      metadata("old-active", "active", 879_999),
    );
    const leaseManager = manager(["maintenance-one"], {
      isProcessAlive: () => true,
    });

    expectMaintenanceConflict(() => {
      leaseManager.acquireMaintenance(databasePath);
    });

    expect(existsSync(paths.activeLease("old-active"))).toBe(true);
    expect(existsSync(paths.maintenance)).toBe(false);
  });

  it("reclaims a heartbeat older than 120 seconds only when its same-host PID is dead", () => {
    const databasePath = fixture();
    const paths = pathsFor(databasePath);
    writeMetadata(
      paths.activeLease("old-active"),
      metadata("old-active", "active", 879_999),
    );
    const leaseManager = manager(["maintenance-one"], {
      isProcessAlive: () => false,
    });

    const maintenance = leaseManager.acquireMaintenance(databasePath);
    handles.push(maintenance);

    expect(maintenance).toMatchObject({
      id: "maintenance-one",
      kind: "maintenance",
    });
    expect(existsSync(paths.activeLease("old-active"))).toBe(false);
    expect(existsSync(paths.maintenance)).toBe(true);
  });

  it("reclaims a stale active lease when its alive PID started after its heartbeat", () => {
    const databasePath = fixture();
    const paths = pathsFor(databasePath);
    writeMetadata(
      paths.activeLease("reused-active"),
      metadata("reused-active", "active", 879_999),
    );
    const leaseManager = manager(["maintenance-one"], {
      isProcessAlive: () => true,
      getProcessStartedAtMs: () => 880_000,
    });

    const maintenance = leaseManager.acquireMaintenance(databasePath);
    handles.push(maintenance);

    expect(existsSync(paths.activeLease("reused-active"))).toBe(false);
    expect(existsSync(paths.maintenance)).toBe(true);
  });

  it("reclaims a stale active lease when unknown liveness still has positive PID-reuse proof", () => {
    const databasePath = fixture();
    const paths = pathsFor(databasePath);
    writeMetadata(
      paths.activeLease("protected-reused-active"),
      metadata("protected-reused-active", "active", 879_999),
    );
    const leaseManager = manager(["maintenance-one"], {
      isProcessAlive: () => "unknown",
      getProcessStartedAtMs: () => 880_000,
    });

    const maintenance = leaseManager.acquireMaintenance(databasePath);
    handles.push(maintenance);

    expect(existsSync(paths.activeLease("protected-reused-active"))).toBe(false);
    expect(existsSync(paths.maintenance)).toBe(true);
  });

  it.skipIf(process.platform !== "win32")(
    "uses CIM absence when Windows denies the PID liveness check",
    () => {
      const databasePath = fixture();
      const paths = pathsFor(databasePath);
      const now = Date.now();
      const missingPid = 2_147_483_647;
      writeMetadata(
        paths.activeLease("protected-dead-active"),
        metadata("protected-dead-active", "active", now - 120_001, {
          hostname: hostname(),
          pid: missingPid,
        }),
      );
      const denied = Object.assign(new Error("kill EPERM"), { code: "EPERM" });
      const kill = vi.spyOn(process, "kill").mockImplementation(() => {
        throw denied;
      });
      const getProcessStartedAtMs = vi.fn(() => "unknown" as const);

      try {
        const leaseManager = createLeaseManager({
          nowMs: () => now,
          newId: () => "maintenance-one",
          hostname: hostname(),
          heartbeatMs: 60_000,
          staleMs: 120_000,
          getProcessStartedAtMs,
        });
        const maintenance = leaseManager.acquireMaintenance(databasePath);
        handles.push(maintenance);
      } finally {
        kill.mockRestore();
      }

      expect(existsSync(paths.activeLease("protected-dead-active"))).toBe(false);
      expect(existsSync(paths.maintenance)).toBe(true);
      expect(getProcessStartedAtMs).not.toHaveBeenCalled();
    },
  );

  it.skipIf(process.platform !== "win32")(
    "reclaims a stale lease through the Windows process-start probe",
    () => {
      const databasePath = fixture();
      const paths = pathsFor(databasePath);
      const now = Date.now();
      const child = spawn(
        process.execPath,
        ["-e", "setTimeout(() => {}, 30_000)"],
        { stdio: "ignore", windowsHide: true },
      );
      childProcesses.push(child);
      expect(child.pid).toBeTypeOf("number");
      writeMetadata(
        paths.activeLease("reused-active"),
        metadata("reused-active", "active", now - 120_001, {
          hostname: hostname(),
          pid: child.pid!,
        }),
      );
      const leaseManager = createLeaseManager({
        nowMs: () => now,
        newId: () => "maintenance-one",
        hostname: hostname(),
        heartbeatMs: 60_000,
        staleMs: 120_000,
        isProcessAlive: () => true,
      });

      const maintenance = leaseManager.acquireMaintenance(databasePath);
      handles.push(maintenance);

      expect(existsSync(paths.activeLease("reused-active"))).toBe(false);
      expect(existsSync(paths.maintenance)).toBe(true);
    },
  );

  it.skipIf(process.platform !== "win32")(
    "falls back to CIM when Get-Process cannot expose StartTime",
    () => {
      const expectedStartedAt = 1_786_307_207_822;
      const script = [
        "function Get-Process { param($Id, $ErrorAction) [pscustomobject]@{ StartTime = $null } }",
        "function Get-CimInstance { param($ClassName, $Filter, $ErrorAction) " +
          `[pscustomobject]@{ CreationDate = [DateTimeOffset]::FromUnixTimeMilliseconds(${expectedStartedAt}).LocalDateTime } }`,
        WINDOWS_PROCESS_START_SCRIPT,
      ].join("; ");

      expect(runProcessStartScript(script, 17_976)).toBe(
        String(expectedStartedAt),
      );
    },
  );

  it.skipIf(process.platform !== "win32")(
    "emits no timestamp when both Windows process probes fail",
    () => {
      const script = [
        "function Get-Process { param($Id, $ErrorAction) throw 'unavailable' }",
        "function Get-CimInstance { param($ClassName, $Filter, $ErrorAction) throw 'unavailable' }",
        WINDOWS_PROCESS_START_SCRIPT,
      ].join("; ");

      expect(() => runProcessStartScript(script, 17_976)).toThrow();
    },
  );

  it("reclaims stale maintenance when its alive PID started after its heartbeat", () => {
    const databasePath = fixture();
    const paths = pathsFor(databasePath);
    writeMetadata(
      paths.maintenance,
      metadata("reused-maintenance", "maintenance", 879_999),
    );
    const leaseManager = manager(["active-one"], {
      isProcessAlive: () => true,
      getProcessStartedAtMs: () => 880_000,
    });

    const active = leaseManager.acquireActive(databasePath);
    handles.push(active);

    expect(existsSync(paths.maintenance)).toBe(false);
    expect(existsSync(paths.activeLease("active-one"))).toBe(true);
  });

  it("retains a stale lease when the alive process started before its heartbeat", () => {
    const databasePath = fixture();
    const paths = pathsFor(databasePath);
    writeMetadata(
      paths.activeLease("live-active"),
      metadata("live-active", "active", 879_999),
    );
    const leaseManager = manager(["maintenance-one"], {
      isProcessAlive: () => true,
      getProcessStartedAtMs: () => 879_998,
    });

    expectMaintenanceConflict(() => {
      leaseManager.acquireMaintenance(databasePath);
    });
    expect(existsSync(paths.activeLease("live-active"))).toBe(true);
  });

  it("retains a stale lease when the alive process started at its heartbeat", () => {
    const databasePath = fixture();
    const paths = pathsFor(databasePath);
    writeMetadata(
      paths.activeLease("live-active"),
      metadata("live-active", "active", 879_999),
    );
    const leaseManager = manager(["maintenance-one"], {
      isProcessAlive: () => true,
      getProcessStartedAtMs: () => 879_999,
    });

    expectMaintenanceConflict(() => {
      leaseManager.acquireMaintenance(databasePath);
    });
    expect(existsSync(paths.activeLease("live-active"))).toBe(true);
    expect(existsSync(paths.maintenance)).toBe(false);
  });

  it("retains a stale foreign-host lease without probing local process identity", () => {
    const databasePath = fixture();
    const paths = pathsFor(databasePath);
    writeMetadata(
      paths.activeLease("foreign-active"),
      metadata("foreign-active", "active", 879_999, {
        hostname: "other-host",
      }),
    );
    const isProcessAlive = vi.fn(() => true);
    const getProcessStartedAtMs = vi.fn(() => 880_000);
    const leaseManager = manager(["maintenance-one"], {
      isProcessAlive,
      getProcessStartedAtMs,
    });

    expectMaintenanceConflict(() => {
      leaseManager.acquireMaintenance(databasePath);
    });
    expect(existsSync(paths.activeLease("foreign-active"))).toBe(true);
    expect(existsSync(paths.maintenance)).toBe(false);
    expect(isProcessAlive).not.toHaveBeenCalled();
    expect(getProcessStartedAtMs).not.toHaveBeenCalled();
  });

  it.each([
    ["returns unknown", () => "unknown" as const],
    ["throws", () => { throw new Error("process inspection failed"); }],
  ])("fails closed when the process-start probe %s", (_case, probe) => {
    const databasePath = fixture();
    const paths = pathsFor(databasePath);
    writeMetadata(
      paths.activeLease("unknown-active"),
      metadata("unknown-active", "active", 879_999),
    );
    const leaseManager = manager(["maintenance-one"], {
      isProcessAlive: () => true,
      getProcessStartedAtMs: probe,
    });

    expectMaintenanceConflict(() => {
      leaseManager.acquireMaintenance(databasePath);
    });
    expect(existsSync(paths.activeLease("unknown-active"))).toBe(true);
  });

  it("does not inspect process start time after proving the PID is dead", () => {
    const databasePath = fixture();
    const paths = pathsFor(databasePath);
    writeMetadata(
      paths.activeLease("dead-active"),
      metadata("dead-active", "active", 879_999),
    );
    const getProcessStartedAtMs = vi.fn(() => "unknown" as const);
    const leaseManager = manager(["maintenance-one"], {
      isProcessAlive: () => false,
      getProcessStartedAtMs,
    });

    const maintenance = leaseManager.acquireMaintenance(databasePath);
    handles.push(maintenance);
    expect(getProcessStartedAtMs).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid JSON", "{not-json"],
    [
      "unknown fields",
      JSON.stringify({
        ...metadata("unsafe-active", "active", 1_000_000),
        projectBody: "must not be accepted",
      }),
    ],
  ])("fails closed for %s in active lease metadata", (_case, document) => {
    const databasePath = fixture();
    const paths = pathsFor(databasePath);
    writeMetadata(paths.activeLease("unsafe-active"), document);
    const leaseManager = manager(["maintenance-one"], {
      isProcessAlive: () => false,
    });

    expectMaintenanceConflict(() => {
      leaseManager.acquireMaintenance(databasePath);
    });

    expect(existsSync(paths.activeLease("unsafe-active"))).toBe(true);
    expect(existsSync(paths.maintenance)).toBe(false);
  });

  it("fails closed and preserves an unreadable active lease filesystem object", () => {
    const databasePath = fixture();
    const paths = pathsFor(databasePath);
    mkdirSync(paths.activeLease("unreadable-active"), { recursive: true });
    const leaseManager = manager(["maintenance-one"], {
      isProcessAlive: () => false,
    });

    expectMaintenanceConflict(() => {
      leaseManager.acquireMaintenance(databasePath);
    });

    expect(statSync(paths.activeLease("unreadable-active")).isDirectory()).toBe(true);
    expect(existsSync(paths.maintenance)).toBe(false);
  });

  it("fails closed when an abandoned maintenance lease has unknown liveness", () => {
    const databasePath = fixture();
    const paths = pathsFor(databasePath);
    writeMetadata(
      paths.maintenance,
      metadata("old-maintenance", "maintenance", 879_999),
    );
    const leaseManager = manager(["active-one"], {
      isProcessAlive: () => "unknown",
    });

    expectMaintenanceConflict(() => {
      leaseManager.acquireActive(databasePath);
    });

    expect(existsSync(paths.maintenance)).toBe(true);
    expect(existsSync(paths.activeLease("active-one"))).toBe(false);
  });

  it("post-create rechecks maintenance intent during an active acquisition race", () => {
    const databasePath = fixture();
    const maintenanceManager = manager(["maintenance-racer"]);
    let maintenance: LeaseHandle | undefined;
    const activeManager = manager([], {
      newId: () => {
        maintenance = maintenanceManager.acquireMaintenance(databasePath);
        handles.push(maintenance);
        return "active-racer";
      },
    });

    expectMaintenanceConflict(() => {
      activeManager.acquireActive(databasePath);
    });

    expect(maintenance).toMatchObject({
      id: "maintenance-racer",
      kind: "maintenance",
    });
    expect(existsSync(pathsFor(databasePath).maintenance)).toBe(true);
    expect(existsSync(pathsFor(databasePath).activeLease("active-racer"))).toBe(false);
  });

  it("uses one canonical lease root for directory aliases of the same database", () => {
    const databasePath = fixture();
    writeFileSync(databasePath, "");
    const aliasContainer = mkdtempSync(join(tmpdir(), "intentarc-lease-alias-"));
    directories.push(aliasContainer);
    const aliasDirectory = join(aliasContainer, "database-parent");
    symlinkSync(
      join(databasePath, ".."),
      aliasDirectory,
      process.platform === "win32" ? "junction" : "dir",
    );
    const aliasedPath = join(aliasDirectory, "project.sqlite");
    const leaseManager = manager(["active-alias", "maintenance-primary"]);
    handles.push(leaseManager.acquireActive(aliasedPath));

    expectMaintenanceConflict(() => {
      leaseManager.acquireMaintenance(databasePath);
    });

    const canonicalPath = realpathSync(databasePath);
    expect(
      existsSync(pathsFor(canonicalPath).activeLease("active-alias")),
    ).toBe(true);
  });

  it.skipIf(!supportsFileSymlinks)(
    "uses one canonical lease root for a file symlink alias",
    () => {
      const databasePath = fixture();
      writeFileSync(databasePath, "");
      const aliasPath = join(databasePath, "..", "project-link.sqlite");
      symlinkSync(databasePath, aliasPath, "file");
      const leaseManager = manager([
        "active-alias",
        "maintenance-primary",
      ]);
      handles.push(leaseManager.acquireActive(aliasPath));

      expectMaintenanceConflict(() => {
        leaseManager.acquireMaintenance(databasePath);
      });

      expect(
        existsSync(
          pathsFor(realpathSync(databasePath)).activeLease("active-alias"),
        ),
      ).toBe(true);
      expect(existsSync(`${aliasPath}.intentarc-lock`)).toBe(false);
    },
  );

  it("rejects every hard-linked spelling of a primary database", () => {
    const databasePath = fixture();
    writeFileSync(databasePath, "");
    const aliasPath = join(databasePath, "..", "project-hard-link.sqlite");
    linkSync(databasePath, aliasPath);
    const leaseManager = manager(["must-not-be-created"]);

    expectMaintenanceConflict(() => {
      leaseManager.acquireActive(databasePath);
    });
    expectMaintenanceConflict(() => {
      leaseManager.acquireMaintenance(aliasPath);
    });

    expect(existsSync(pathsFor(databasePath).root)).toBe(false);
    expect(existsSync(pathsFor(aliasPath).root)).toBe(false);
  });

  it("atomically hands owned maintenance access to an active lease", () => {
    const databasePath = fixture();
    const leaseManager = manager([
      "maintenance-one",
      "active-after-handoff",
      "conflicting-maintenance",
    ]);
    const maintenance = leaseManager.acquireMaintenance(databasePath);
    handles.push(maintenance);

    const active = leaseManager.handoffMaintenanceToActive(
      databasePath,
      maintenance,
    );
    handles.push(active);

    expect(active).toMatchObject({
      id: "active-after-handoff",
      kind: "active",
    });
    expect(existsSync(pathsFor(databasePath).maintenance)).toBe(false);
    expect(
      existsSync(pathsFor(databasePath).activeLease("active-after-handoff")),
    ).toBe(true);
    expectMaintenanceConflict(() => {
      leaseManager.acquireMaintenance(databasePath);
    });
  });
});
