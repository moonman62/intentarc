import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  renameSync,
  symlinkSync,
  watch,
  writeFileSync,
} from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  SupervisorProcessIdentity,
  SupervisorSettlementResult,
} from "./client-portability-supervisor-client.js";
import { observeWindowsSupervisorIdentity } from "./client-portability-windows-settlement.js";
import {
  cleanupPreservedClientPortabilityRoot,
  finalizeClientPortabilityCleanup,
  inspectClientPortabilityWindowsPathBoundary,
  type PortabilityCleanupResult,
  type PortabilityCleanupInput,
} from "./client-portability-cleanup.js";
import { runClientPortabilityCleanupCli } from "./client-portability-cleanup-cli.js";

const createdParents = new Set<string>();

const settled = (
  retained: readonly SupervisorProcessIdentity[] = [],
): SupervisorSettlementResult => ({
  status: "settled",
  category: "none",
  retained,
});

const blocked = (
  retained: readonly SupervisorProcessIdentity[] = [{ pid: 2_147_483_647, startTime: "1" }],
  category: SupervisorSettlementResult["category"] = "child_handle",
): SupervisorSettlementResult => ({
  status: "blocked",
  category,
  retained,
});

const unsupported = (): SupervisorSettlementResult => ({
  status: "unsupported",
  category: "platform",
  retained: [],
});

interface CleanupFixture {
  readonly parent: string;
  readonly root: string;
  readonly runId: string;
}

const createFixture = async (): Promise<CleanupFixture> => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "intentarc-cleanup-parent-")));
  createdParents.add(parent);
  const runId = randomUUID();
  const root = join(parent, `intentarc-client-portability-live-${runId}`);
  await mkdir(root);
  return { parent, root, runId };
};

const validInput = (
  fixture: CleanupFixture,
  overrides: Partial<PortabilityCleanupInput> = {},
): PortabilityCleanupInput => ({
  runId: fixture.runId,
  root: fixture.root,
  temporaryParent: fixture.parent,
  sessions: [settled(), settled()],
  requestsDrained: true,
  workspaceClosed: true,
  configurationAbsent: true,
  ...overrides,
});

const expectPresent = async (path: string): Promise<void> => {
  expect((await lstat(path)).isDirectory()).toBe(true);
};

const expectAbsent = async (path: string): Promise<void> => {
  await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
};

const withProcessPlatform = async <Result>(
  platform: NodeJS.Platform,
  action: () => Promise<Result>,
): Promise<Result> => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  if (descriptor === undefined) throw new Error("process.platform descriptor unavailable");
  Object.defineProperty(process, "platform", { ...descriptor, value: platform });
  try {
    return await action();
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
};

afterEach(async () => {
  vi.restoreAllMocks();
  for (const parent of createdParents) {
    await rm(parent, { recursive: true, force: true });
  }
  createdParents.clear();
});

describe("automatic client-portability cleanup authority", () => {
  it("keeps native deletion exact, compiler-free, and receipt reads bounded", async () => {
    const source = await readFile(
      new URL("./client-portability-cleanup.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain("PathComparison = StringComparison.OrdinalIgnoreCase");
    expect(source).not.toContain(
      "$actual.Equals($expected, [StringComparison]::OrdinalIgnoreCase)",
    );
    expect(source).not.toMatch(/RootFinalPath[\s\S]{0,120}StringComparison\]::OrdinalIgnoreCase/);
    expect(source).not.toContain("Add-Type");
    expect(source).not.toMatch(/\bfile\.readFile\(/);
    const unknownCount = {
      status: "cleanup_failed",
      category: "root",
      residuePath: null,
      removedEntries: null,
    } satisfies PortabilityCleanupResult;
    expect(unknownCount.removedEntries).toBeNull();
  });

  it.runIf(process.platform === "win32")(
    "uses the exact Windows reparse attribute for the full root tree",
    async () => {
      const fixture = await createFixture();
      expect(await inspectClientPortabilityWindowsPathBoundary({
        root: fixture.root,
        temporaryParent: fixture.parent,
        includeTree: true,
        deadline: Date.now() + 5_000,
      })).toBe("safe");
      const target = await realpath(await mkdtemp(join(tmpdir(), "intentarc-cleanup-attribute-target-")));
      createdParents.add(target);
      await symlink(target, join(fixture.root, "attribute-reparse"), "junction");

      expect(await inspectClientPortabilityWindowsPathBoundary({
        root: fixture.root,
        temporaryParent: fixture.parent,
        includeTree: true,
        deadline: Date.now() + 5_000,
      })).toBe("reparse");
    },
  );

  it.each([
    ["blocked session", { sessions: [settled(), blocked()] }],
  ] as const)("preserves a safe root for %s with one actionable process receipt", async (
    _name,
    overrides,
  ) => {
    const fixture = await createFixture();
    await writeFile(join(fixture.root, "keep.txt"), "keep", "utf8");

    const result = await finalizeClientPortabilityCleanup(validInput(fixture, overrides));

    expect(result).toMatchObject({
      status: "preserved",
      category: "settlement",
    });
    if (result.status !== "preserved") throw new Error("expected preservation");
    expect(result.receiptPath).toBe(join(
      fixture.root,
      ".intentarc-client-portability-recovery.json",
    ));
    expect(result.recoveryCommand).toBe(
      `pnpm desktop:test:client-portability:cleanup -- --receipt "${result.receiptPath}"`,
    );
    expect(result.receiptPath === null).toBe(result.recoveryCommand === null);
    await expectPresent(fixture.root);

    const receiptText = await readFile(result.receiptPath!, "utf8");
    const receipt = JSON.parse(receiptText) as Record<string, unknown>;
    expect(Object.keys(receipt)).toEqual([
      "schema",
      "runId",
      "root",
      "identities",
      "categories",
      "createdAt",
    ]);
    expect(receipt).toEqual({
      schema: "intentarc.client-portability-recovery/v1",
      runId: fixture.runId,
      root: fixture.root,
      identities: [{ pid: 2_147_483_647, startTime: "1" }],
      categories: ["process_settlement"],
      createdAt: expect.any(Number),
    });
    expect(receiptText).not.toMatch(/credential|token|stderr|environment|error/i);
  });

  it("PowerShell-escapes an actionable receipt path exactly once", async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), "intentarc-$cleanup-parent-")));
    createdParents.add(parent);
    const runId = randomUUID();
    const root = join(parent, `intentarc-client-portability-live-${runId}`);
    await mkdir(root);

    const result = await finalizeClientPortabilityCleanup(validInput(
      { parent, root, runId },
      { sessions: [blocked(), settled()] },
    ));

    expect(result).toMatchObject({ status: "preserved" });
    if (result.status !== "preserved") throw new Error("expected preservation");
    expect(result.recoveryCommand).toContain("intentarc-`$cleanup-parent-");
    expect(result.recoveryCommand).not.toContain("intentarc-$cleanup-parent-");
  });

  it.each([
    ["unsupported session", { sessions: [settled(), unsupported()] }, "settlement"],
    ["pending request registry", { requestsDrained: false }, "settlement"],
    ["workspace close failure", { workspaceClosed: false }, "workspace"],
    ["configuration absence failure", { configurationAbsent: false }, "configuration"],
  ] as const)("preserves without an unsafe recovery authority after %s", async (
    _name,
    overrides,
    category,
  ) => {
    const fixture = await createFixture();

    const result = await finalizeClientPortabilityCleanup(validInput(fixture, overrides));

    expect(result).toEqual({
      status: "preserved",
      receiptPath: null,
      recoveryCommand: null,
      category,
    });
    await expectPresent(fixture.root);
  });

  it.each([
    ["not exactly two session receipts", [settled()]],
    ["a blocked session without exact identity evidence", [blocked([]), settled()]],
    ["more than 256 retained identities", [blocked(Array.from(
      { length: 257 },
      (_value, index) => ({ pid: index + 1, startTime: "1" }),
    )), settled()]],
    ["one PID with conflicting creation identities", [blocked([
      { pid: 41, startTime: "100" },
    ]), settled([{ pid: 41, startTime: "101" }])]],
  ] as const)("does not issue recovery authority for %s", async (_name, sessions) => {
    const fixture = await createFixture();

    const result = await finalizeClientPortabilityCleanup(validInput(fixture, { sessions }));

    expect(result).toEqual({
      status: "preserved",
      receiptPath: null,
      recoveryCommand: null,
      category: "settlement",
    });
    await expectPresent(fixture.root);
  });

  it.each(["identity", "observation", "termination"] as const)(
    "does not mint incomplete recovery authority for blocked/%s",
    async (category) => {
      const fixture = await createFixture();

      const result = await finalizeClientPortabilityCleanup(validInput(fixture, {
        sessions: [blocked(undefined, category), settled()],
      }));

      expect(result).toEqual({
        status: "preserved",
        receiptPath: null,
        recoveryCommand: null,
        category: "settlement",
      });
      await expectPresent(fixture.root);
    },
  );

  it("fails closed when the rename-out/rename-back probe cannot claim its sibling", async () => {
    const fixture = await createFixture();
    await mkdir(`${fixture.root}.settlement-${fixture.runId}`);

    const result = await finalizeClientPortabilityCleanup(validInput(fixture));

    expect(result).toEqual({
      status: "preserved",
      receiptPath: null,
      recoveryCommand: null,
      category: "workspace",
    });
    await expectPresent(fixture.root);
  });

  it("fails closed off Windows even when settlement data claims success", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.root, "keep.txt"), "keep", "utf8");

    const result = await withProcessPlatform("linux", () =>
      finalizeClientPortabilityCleanup(validInput(fixture)));

    expect(result).toEqual({
      status: "preserved",
      receiptPath: null,
      recoveryCommand: null,
      category: "settlement",
    });
    expect(await readFile(join(fixture.root, "keep.txt"), "utf8")).toBe("keep");
  });

  it("rejects a non-UUID exact-root name without writing through it", async () => {
    const fixture = await createFixture();
    const wrongRoot = join(fixture.parent, "intentarc-client-portability-live-not-a-uuid");
    await mkdir(wrongRoot);

    const result = await finalizeClientPortabilityCleanup({
      ...validInput(fixture),
      root: wrongRoot,
    });

    expect(result).toEqual({
      status: "preserved",
      receiptPath: null,
      recoveryCommand: null,
      category: "root",
    });
    await expectPresent(wrongRoot);
    await expectAbsent(join(wrongRoot, ".intentarc-client-portability-recovery.json"));
  });

  it("rejects a validly named sibling outside the declared canonical parent", async () => {
    const fixture = await createFixture();
    const otherParent = await realpath(await mkdtemp(join(tmpdir(), "intentarc-cleanup-other-")));
    createdParents.add(otherParent);

    const result = await finalizeClientPortabilityCleanup({
      ...validInput(fixture),
      temporaryParent: otherParent,
    });

    expect(result).toEqual({
      status: "preserved",
      receiptPath: null,
      recoveryCommand: null,
      category: "root",
    });
    await expectPresent(fixture.root);
  });

  it.runIf(process.platform === "win32")(
    "rejects a case-distinct canonical parent instead of collapsing its identity",
    async () => {
      const grandparent = await realpath(await mkdtemp(join(tmpdir(), "intentarc-case-parent-boundary-")));
      createdParents.add(grandparent);
      execFileSync("fsutil.exe", ["file", "setCaseSensitiveInfo", grandparent, "enable"], {
        windowsHide: true,
        stdio: "ignore",
      });
      const parent = join(grandparent, "portable-parent");
      const caseDistinctParent = join(grandparent, "PORTABLE-PARENT");
      await mkdir(parent);
      await mkdir(caseDistinctParent);
      const runId = randomUUID();
      const root = join(parent, `intentarc-client-portability-live-${runId}`);
      await mkdir(root);

      const result = await finalizeClientPortabilityCleanup(validInput(
        { parent: caseDistinctParent, root, runId },
      ));

      expect(result).toEqual({
        status: "preserved",
        receiptPath: null,
        recoveryCommand: null,
        category: "root",
      });
      await expectPresent(root);
    },
  );

  it.runIf(process.platform === "win32")(
    "rejects a root junction and does not write into its target",
    async () => {
      const fixture = await createFixture();
      await rm(fixture.root, { recursive: true });
      const target = await realpath(await mkdtemp(join(tmpdir(), "intentarc-cleanup-target-")));
      createdParents.add(target);
      await symlink(target, fixture.root, "junction");

      const result = await finalizeClientPortabilityCleanup(validInput(fixture));

      expect(result).toEqual({
        status: "preserved",
        receiptPath: null,
        recoveryCommand: null,
        category: "root",
      });
      await expectAbsent(join(target, ".intentarc-client-portability-recovery.json"));
    },
  );

  it.runIf(process.platform === "win32")(
    "rejects a reparse ancestor of the declared temporary parent",
    async () => {
      const physicalParent = await realpath(await mkdtemp(join(tmpdir(), "intentarc-cleanup-physical-")));
      createdParents.add(physicalParent);
      const aliasContainer = await realpath(await mkdtemp(join(tmpdir(), "intentarc-cleanup-alias-")));
      createdParents.add(aliasContainer);
      const linkedParent = join(aliasContainer, "linked-parent");
      await symlink(physicalParent, linkedParent, "junction");
      const runId = randomUUID();
      const root = join(linkedParent, `intentarc-client-portability-live-${runId}`);
      await mkdir(root);

      const result = await finalizeClientPortabilityCleanup({
        runId,
        root,
        temporaryParent: linkedParent,
        sessions: [settled(), settled()],
        requestsDrained: true,
        workspaceClosed: true,
        configurationAbsent: true,
      });

      expect(result).toEqual({
        status: "preserved",
        receiptPath: null,
        recoveryCommand: null,
        category: "root",
      });
      await expectPresent(resolve(root));
    },
  );

  it.runIf(process.platform === "win32")(
    "refuses a nested junction without following or deleting its target",
    async () => {
      const fixture = await createFixture();
      const target = await realpath(await mkdtemp(join(tmpdir(), "intentarc-cleanup-nested-target-")));
      createdParents.add(target);
      await writeFile(join(target, "outside.txt"), "outside", "utf8");
      await symlink(target, join(fixture.root, "escape"), "junction");

      const result = await finalizeClientPortabilityCleanup(validInput(fixture));

      expect(result).toEqual({
        status: "preserved",
        receiptPath: null,
        recoveryCommand: null,
        category: "root",
      });
      expect(await readFile(join(target, "outside.txt"), "utf8")).toBe("outside");
      await expectPresent(fixture.root);
    },
  );

  it("refuses more than 1,024 entries without partial removal", async () => {
    const fixture = await createFixture();
    await Promise.all(Array.from({ length: 1_025 }, (_value, index) =>
      writeFile(join(fixture.root, `entry-${index}`), "x")));

    const result = await finalizeClientPortabilityCleanup(validInput(fixture));

    expect(result).toMatchObject({ status: "preserved", category: "root" });
    await expectPresent(fixture.root);
    expect(await readdir(fixture.root)).toHaveLength(1_025);
  });

  it("refuses depth greater than 32 without partial removal", async () => {
    const fixture = await createFixture();
    let directory = fixture.root;
    for (let depth = 0; depth < 33; depth += 1) {
      directory = join(directory, `d${depth}`);
      await mkdir(directory);
    }
    await writeFile(join(directory, "deep.txt"), "deep", "utf8");

    const result = await finalizeClientPortabilityCleanup(validInput(fixture));

    expect(result).toMatchObject({ status: "preserved", category: "root" });
    await expectPresent(fixture.root);
    expect(await readFile(join(directory, "deep.txt"), "utf8")).toBe("deep");
  });

  it("refuses cleanup when the five-second proof deadline expires", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.root, "kept.txt"), "keep", "utf8");
    const start = 1_000_000;
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(start)
      .mockReturnValueOnce(start)
      .mockReturnValue(start + 5_001);

    const result = await finalizeClientPortabilityCleanup(validInput(fixture));

    expect(result).toMatchObject({ status: "preserved", category: "workspace" });
    expect(await readFile(join(fixture.root, "kept.txt"), "utf8")).toBe("keep");
  });

  it.runIf(process.platform === "win32")(
    "reports destructive uncertainty instead of preservation when a post-walk entry prevents completion",
    async () => {
      const fixture = await createFixture();
      await writeFile(join(fixture.root, "one.txt"), "one", "utf8");
      await writeFile(join(fixture.root, "two.txt"), "two", "utf8");
      let injected = false;
      const watcher = watch(fixture.root, { recursive: true }, () => {
        if (injected) return;
        const quarantineName = readdirSync(fixture.parent).find((entry) =>
          entry.startsWith(`${basename(fixture.root)}.cleanup-`));
        if (quarantineName === undefined) return;
        injected = true;
        writeFileSync(join(fixture.parent, quarantineName, "late.txt"), "late", "utf8");
      });
      try {
        const result = await finalizeClientPortabilityCleanup(validInput(fixture));

        expect(injected).toBe(true);
        expect(result).toMatchObject({
          status: "cleanup_failed",
          category: "root",
          residuePath: expect.any(String),
          removedEntries: 2,
        });
        if (result.status !== "cleanup_failed" || result.residuePath === null) {
          throw new Error("expected cleanup residue");
        }
        await expectPresent(result.residuePath);
        expect(await readFile(join(result.residuePath, "late.txt"), "utf8")).toBe("late");
      } finally {
        watcher.close();
      }
    },
  );

  it.runIf(process.platform === "win32")(
    "never follows an ancestor swapped to a junction after quarantine inspection",
    async () => {
      const fixture = await createFixture();
      const nested = join(fixture.root, "aaa-nested");
      await mkdir(nested);
      await writeFile(join(nested, "victim.txt"), "inside", "utf8");
      await writeFile(join(fixture.root, "zzz-trigger.txt"), "trigger", "utf8");
      const outside = await realpath(await mkdtemp(join(tmpdir(), "intentarc-cleanup-swap-target-")));
      createdParents.add(outside);
      await writeFile(join(outside, "victim.txt"), "outside", "utf8");
      let swapped = false;
      const watcher = watch(fixture.root, { recursive: true }, (_event, filename) => {
        if (swapped || filename !== "zzz-trigger.txt") return;
        const quarantineName = readdirSync(fixture.parent).find((entry) =>
          entry.startsWith(`${basename(fixture.root)}.cleanup-`));
        if (quarantineName === undefined) return;
        const quarantine = join(fixture.parent, quarantineName);
        try {
          const nestedInQuarantine = join(quarantine, "aaa-nested");
          const parked = join(quarantine, "aaa-parked");
          // Synchronous operations place the swap exactly between two awaited deletes.
          renameSync(nestedInQuarantine, parked);
          symlinkSync(outside, nestedInQuarantine, "junction");
          swapped = true;
        } catch {
          // If cleanup already completed, the assertion below fails closed.
        }
      });
      try {
        const result = await finalizeClientPortabilityCleanup(validInput(fixture));

        expect(swapped).toBe(true);
        expect(result).toMatchObject({
          status: "cleanup_failed",
          category: "root",
          removedEntries: 1,
        });
        expect(await readFile(join(outside, "victim.txt"), "utf8")).toBe("outside");
      } finally {
        watcher.close();
      }
    },
  );

  it.runIf(process.platform === "win32")(
    "rejects a case-distinct external sibling after an opened directory is swapped",
    async () => {
      const parent = await realpath(await mkdtemp(join(tmpdir(), "intentarc-cleanup-case-parent-")));
      createdParents.add(parent);
      execFileSync("fsutil.exe", ["file", "setCaseSensitiveInfo", parent, "enable"], {
        windowsHide: true,
        stdio: "ignore",
      });
      const runId = randomUUID();
      const root = join(parent, `intentarc-client-portability-live-${runId}`);
      await mkdir(root);
      const fixture = { parent, root, runId };
      const nested = join(fixture.root, "aaa-nested");
      await mkdir(nested);
      await writeFile(join(nested, "victim.txt"), "inside", "utf8");
      await writeFile(join(nested, "zzz-trigger.txt"), "trigger", "utf8");
      const externalRoot = join(fixture.parent, basename(fixture.root).toUpperCase());
      const externalNested = join(externalRoot, "aaa-nested");
      await mkdir(externalRoot);
      await mkdir(externalNested);
      expect(await realpath(externalRoot)).not.toBe(await realpath(fixture.root));
      await writeFile(join(externalNested, "victim.txt"), "outside", "utf8");
      let swapped = false;
      const watcher = watch(fixture.root, { recursive: true }, (_event, filename) => {
        if (swapped || filename?.toLowerCase() !== join("aaa-nested", "zzz-trigger.txt")) return;
        const quarantineName = readdirSync(fixture.parent).find((entry) =>
          entry.startsWith(`${basename(fixture.root)}.cleanup-`));
        if (quarantineName === undefined) return;
        const nestedInQuarantine = join(fixture.parent, quarantineName, "aaa-nested");
        try {
          renameSync(nestedInQuarantine, join(fixture.parent, quarantineName, "aaa-parked"));
          symlinkSync(externalNested, nestedInQuarantine, "junction");
          swapped = true;
        } catch {
          // If cleanup already completed, the assertion below fails closed.
        }
      });
      try {
        const result = await finalizeClientPortabilityCleanup(validInput(fixture));

        expect(swapped).toBe(true);
        expect(result).toMatchObject({ status: "cleanup_failed", removedEntries: 1 });
        expect(await readFile(join(externalNested, "victim.txt"), "utf8")).toBe("outside");
      } finally {
        watcher.close();
      }
    },
  );

  it.runIf(process.platform === "win32")(
    "removes exactly the proved UUID root after a bounded non-following walk",
    async () => {
      const fixture = await createFixture();
      await mkdir(join(fixture.root, "nested"));
      await writeFile(join(fixture.root, "one.txt"), "one", "utf8");
      await writeFile(join(fixture.root, "nested", "two.txt"), "two", "utf8");

      const result = await finalizeClientPortabilityCleanup(validInput(fixture));

      expect(result).toEqual({ status: "removed", removedEntries: 3 });
      await expectAbsent(fixture.root);
      await expectPresent(fixture.parent);
    },
  );
});

describe("strict observer-only recovery", () => {
  const writeReceipt = async (
    fixture: CleanupFixture,
    text: string,
    receiptPath = join(fixture.root, ".intentarc-client-portability-recovery.json"),
  ): Promise<string> => {
    await writeFile(receiptPath, text, "utf8");
    return receiptPath;
  };

  const receiptJson = (
    fixture: CleanupFixture,
    identities: readonly SupervisorProcessIdentity[] = [{ pid: 2_147_483_647, startTime: "1" }],
  ): string => JSON.stringify({
    schema: "intentarc.client-portability-recovery/v1",
    runId: fixture.runId,
    root: fixture.root,
    identities,
    categories: ["process_settlement"],
    createdAt: Date.now(),
  });

  it.each([
    ["duplicate top-level key", (fixture: CleanupFixture) => `{"schema":"intentarc.client-portability-recovery/v1","schema":"intentarc.client-portability-recovery/v1","runId":"${fixture.runId}","root":${JSON.stringify(fixture.root)},"identities":[],"categories":["process_settlement"],"createdAt":1}`],
    ["duplicate nested key", (fixture: CleanupFixture) => `{"schema":"intentarc.client-portability-recovery/v1","runId":"${fixture.runId}","root":${JSON.stringify(fixture.root)},"identities":[{"pid":99,"pid":99,"startTime":"1"}],"categories":["process_settlement"],"createdAt":1}`],
    ["extra key", (fixture: CleanupFixture) => JSON.stringify({ ...JSON.parse(receiptJson(fixture)), extra: true })],
    ["more than 256 identities", (fixture: CleanupFixture) => receiptJson(fixture, Array.from({ length: 257 }, (_value, index) => ({ pid: index + 1, startTime: "1" })))],
    ["non-UUID run ID", (fixture: CleanupFixture) => JSON.stringify({ ...JSON.parse(receiptJson(fixture)), runId: "not-a-uuid" })],
    ["noncanonical root", (fixture: CleanupFixture) => JSON.stringify({ ...JSON.parse(receiptJson(fixture)), root: `${fixture.root}${join("", "..")}` })],
    ["wrong categories", (fixture: CleanupFixture) => JSON.stringify({ ...JSON.parse(receiptJson(fixture)), categories: ["workspace_close"] })],
    ["empty process identity evidence", (fixture: CleanupFixture) => receiptJson(fixture, [])],
  ])("rejects a forged receipt with %s", async (_name, buildText) => {
    const fixture = await createFixture();
    const receiptPath = await writeReceipt(fixture, buildText(fixture));

    const result = await cleanupPreservedClientPortabilityRoot(receiptPath);

    expect(result).toEqual({
      status: "preserved",
      receiptPath: null,
      recoveryCommand: null,
      category: "root",
    });
    await expectPresent(fixture.root);
  });

  it("rejects a receipt path outside the exact root even when its JSON names the root", async () => {
    const fixture = await createFixture();
    const receiptPath = join(fixture.parent, "forged-recovery.json");
    await writeReceipt(fixture, receiptJson(fixture), receiptPath);

    const result = await cleanupPreservedClientPortabilityRoot(receiptPath);

    expect(result).toMatchObject({ status: "preserved", category: "root" });
    await expectPresent(fixture.root);
  });

  it("rejects a valid receipt copied into a sibling UUID root", async () => {
    const fixture = await createFixture();
    const siblingRunId = randomUUID();
    const sibling = join(fixture.parent, `intentarc-client-portability-live-${siblingRunId}`);
    await mkdir(sibling);
    const receiptPath = join(sibling, ".intentarc-client-portability-recovery.json");
    await writeFile(receiptPath, receiptJson(fixture), "utf8");

    const result = await cleanupPreservedClientPortabilityRoot(receiptPath);

    expect(result).toMatchObject({ status: "preserved", category: "root" });
    await expectPresent(fixture.root);
    await expectPresent(sibling);
  });

  it("keeps a validated receipt actionable when recovery is unsupported off Windows", async () => {
    const fixture = await createFixture();
    const denied = await finalizeClientPortabilityCleanup(validInput(fixture, {
      sessions: [blocked(), settled()],
    }));
    if (denied.status !== "preserved" || denied.receiptPath === null) {
      throw new Error("expected actionable receipt");
    }

    const result = await withProcessPlatform("linux", () =>
      cleanupPreservedClientPortabilityRoot(denied.receiptPath!));

    expect(result).toEqual({
      status: "preserved",
      receiptPath: denied.receiptPath,
      recoveryCommand: denied.recoveryCommand,
      category: "settlement",
    });
    await expectPresent(fixture.root);
  });

  it.runIf(process.platform === "win32")(
    "preserves the root while an exact retained identity remains present",
    async () => {
      const fixture = await createFixture();
      const identity = await observeWindowsSupervisorIdentity(process.pid, Date.now() + 5_000);
      expect(identity).toBeDefined();
      const denied = await finalizeClientPortabilityCleanup(validInput(fixture, {
        sessions: [blocked(identity === undefined ? [] : [identity]), settled()],
      }));
      if (denied.status !== "preserved" || denied.receiptPath === null) {
        throw new Error("expected actionable receipt");
      }

      const result = await cleanupPreservedClientPortabilityRoot(denied.receiptPath);

      expect(result).toEqual({
        status: "preserved",
        receiptPath: denied.receiptPath,
        recoveryCommand: denied.recoveryCommand,
        category: "settlement",
      });
      await expectPresent(fixture.root);
    },
  );

  it.runIf(process.platform === "win32")(
    "keeps the actionable receipt and command after a retryable handle-probe failure",
    async () => {
      const fixture = await createFixture();
      const denied = await finalizeClientPortabilityCleanup(validInput(fixture, {
        sessions: [blocked(), settled()],
      }));
      if (denied.status !== "preserved" || denied.receiptPath === null) {
        throw new Error("expected actionable receipt");
      }
      await mkdir(`${fixture.root}.settlement-${fixture.runId}`);

      const result = await cleanupPreservedClientPortabilityRoot(denied.receiptPath);

      expect(result).toEqual({
        status: "preserved",
        receiptPath: denied.receiptPath,
        recoveryCommand: denied.recoveryCommand,
        category: "workspace",
      });
      await expectPresent(fixture.root);
    },
  );

  it.runIf(process.platform === "win32")(
    "drops retry authority when the validated receipt is replaced before a pre-destructive failure",
    async () => {
      const fixture = await createFixture();
      const denied = await finalizeClientPortabilityCleanup(validInput(fixture, {
        sessions: [blocked(), settled()],
      }));
      if (denied.status !== "preserved" || denied.receiptPath === null) {
        throw new Error("expected actionable receipt");
      }
      const outside = await realpath(await mkdtemp(join(tmpdir(), "intentarc-cleanup-retry-target-")));
      createdParents.add(outside);
      await symlink(outside, join(fixture.root, "preflight-reparse"), "junction");
      let replaced = false;
      const watcher = watch(fixture.parent, (_event, filename) => {
        if (
          replaced
          || filename !== basename(fixture.root)
          || !existsSync(fixture.root)
          || !existsSync(denied.receiptPath!)
        ) return;
        writeFileSync(denied.receiptPath!, "sentinel", "utf8");
        replaced = true;
      });
      try {
        const result = await cleanupPreservedClientPortabilityRoot(denied.receiptPath);

        expect(replaced).toBe(true);
        expect(result).toEqual({
          status: "preserved",
          receiptPath: null,
          recoveryCommand: null,
          category: "root",
        });
      } finally {
        watcher.close();
      }
    },
  );

  it.runIf(process.platform === "win32")(
    "removes only after every recorded exact identity is positively absent",
    async () => {
      const fixture = await createFixture();
      const absentIdentity = { pid: 2_147_483_647, startTime: "1" } as const;
      const denied = await finalizeClientPortabilityCleanup(validInput(fixture, {
        sessions: [blocked([absentIdentity]), settled()],
      }));
      if (denied.status !== "preserved" || denied.receiptPath === null) {
        throw new Error("expected actionable receipt");
      }

      const result = await cleanupPreservedClientPortabilityRoot(denied.receiptPath);

      expect(result).toEqual({ status: "removed", removedEntries: 1 });
      await expectAbsent(fixture.root);
    },
  );

  it.runIf(process.platform === "win32")(
    "never clobbers a receipt path created concurrently with atomic publication",
    async () => {
      const fixture = await createFixture();
      const receiptPath = join(fixture.root, ".intentarc-client-portability-recovery.json");
      let collisionWritten = false;
      const watcher = watch(fixture.root, (_event, filename) => {
        if (
          collisionWritten
          || typeof filename !== "string"
          || !filename.startsWith(".intentarc-client-portability-recovery.json.")
          || !filename.endsWith(".tmp")
        ) return;
        try {
          writeFileSync(receiptPath, "sentinel", { encoding: "utf8", flag: "wx" });
          collisionWritten = true;
        } catch {
          // A no-clobber publisher may already have won the exact race.
        }
      });
      try {
        const result = await finalizeClientPortabilityCleanup(validInput(fixture, {
          sessions: [blocked(), settled()],
        }));

        expect(collisionWritten).toBe(true);
        expect(result).toEqual({
          status: "preserved",
          receiptPath: null,
          recoveryCommand: null,
          category: "settlement",
        });
        expect(await readFile(receiptPath, "utf8")).toBe("sentinel");
      } finally {
        watcher.close();
      }
    },
  );
});

describe("cleanup CLI", () => {
  const runCli = async (argv: readonly string[]) => {
    const lines: string[] = [];
    const exitCode = await runClientPortabilityCleanupCli({
      argv,
      writeLine: (line) => { lines.push(line); },
    });
    return { exitCode, lines };
  };

  it.each([
    [[]],
    [["--receipt"]],
    [["--receipt", "relative.json"]],
    [["--receipt", resolve(tmpdir(), "receipt.json"), "extra"]],
    [["--other", resolve(tmpdir(), "receipt.json")]],
  ])("accepts only the closed --receipt <absolute path> grammar: %j", async (argv) => {
    const result = await runCli(argv);

    expect(result).toEqual({
      exitCode: 1,
      lines: [JSON.stringify({ status: "preserved", category: "arguments" })],
    });
  });

  it("prints one closed privacy-safe failure line for an unreadable receipt", async () => {
    const missing = resolve(tmpdir(), `missing-${randomUUID()}.json`);

    const result = await runCli(["--receipt", missing]);

    expect(result).toEqual({
      exitCode: 1,
      lines: [JSON.stringify({ status: "preserved", category: "root" })],
    });
    expect(result.lines[0]).not.toContain(missing);
  });

  it.runIf(process.platform === "win32")(
    "exits zero only for removal and prints exactly one closed result line",
    async () => {
      const fixture = await createFixture();
      const denied = await finalizeClientPortabilityCleanup(validInput(fixture, {
        sessions: [blocked([{ pid: 2_147_483_647, startTime: "1" }]), settled()],
      }));
      if (denied.status !== "preserved" || denied.receiptPath === null) {
        throw new Error("expected actionable receipt");
      }

      const result = await runCli(["--receipt", denied.receiptPath]);

      expect(result).toEqual({
        exitCode: 0,
        lines: [JSON.stringify({ status: "removed", removedEntries: 1 })],
      });
    },
  );

  it.runIf(process.platform === "win32")(
    "redacts destructive residue and exits one for cleanup failure",
    async () => {
      const fixture = await createFixture();
      await writeFile(join(fixture.root, "payload.txt"), "payload", "utf8");
      const denied = await finalizeClientPortabilityCleanup(validInput(fixture, {
        sessions: [blocked(), settled()],
      }));
      if (denied.status !== "preserved" || denied.receiptPath === null) {
        throw new Error("expected actionable receipt");
      }
      let injected = false;
      const watcher = watch(fixture.root, { recursive: true }, () => {
        if (injected) return;
        const quarantineName = readdirSync(fixture.parent).find((entry) =>
          entry.startsWith(`${basename(fixture.root)}.cleanup-`));
        if (quarantineName === undefined) return;
        injected = true;
        writeFileSync(join(fixture.parent, quarantineName, "late.txt"), "late", "utf8");
      });
      try {
        const result = await runCli(["--receipt", denied.receiptPath]);

        expect(result).toEqual({
          exitCode: 1,
          lines: [JSON.stringify({ status: "cleanup_failed", category: "root" })],
        });
        expect(result.lines[0]).not.toContain(fixture.root);
      } finally {
        watcher.close();
      }
    },
  );
});
