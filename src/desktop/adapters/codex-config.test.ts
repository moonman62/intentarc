import {
  writeFileSync,
} from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { afterEach, describe, expect, it } from "vitest";
import {
  CODEX_INTENTARC_BLOCK_END,
  CODEX_INTENTARC_BLOCK_START,
  codexConfigPath,
  createCodexConfigManager,
} from "./codex-config.js";

const roots: string[] = [];

const createConfigPath = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "intentarc-codex-config-"));
  roots.push(root);
  return join(root, "config.toml");
};

const disabledOriginal = [
  "# unrelated comment",
  'model = "gpt-5.4"',
  "",
  "[mcp_servers.intentarc]",
  'command = "C:\\\\Old\\\\IntentArc Bridge.exe"',
  'args = ["--connection", "old-connection"]',
  "enabled = false",
  "",
  "[features]",
  "multi_agent = true # preserve exactly",
  "",
].join("\n");

const attemptedConfig = [
  "# unrelated comment",
  'model = "gpt-5.4"',
  "",
  "[mcp_servers.intentarc]",
  'command = "C:\\\\New\\\\IntentArc Bridge.exe"',
  'args = ["--connection", "new-connection"]',
  "enabled = true",
  "",
  "[features]",
  "multi_agent = true # preserve exactly",
  "",
].join("\n");

const prepareExternalRepair = async (configPath: string) => {
  await writeFile(configPath, disabledOriginal, "utf8");
  const transaction = await createCodexConfigManager({
    configPath,
  }).prepareConnection({
    bridgeExecutable: "C:\\New\\IntentArc Bridge.exe",
    connectionId: "new-connection",
  });
  await writeFile(configPath, attemptedConfig, "utf8");
  return transaction;
};

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true }),
  ));
});

describe("Codex configuration fallback", () => {
  it("resolves CODEX_HOME before the default home directory", () => {
    expect(codexConfigPath({
      environment: {
        CODEX_HOME: "C:\\isolated\\codex-home",
      },
      homeDirectory: "C:\\isolated\\user-home",
      platform: "win32",
    })).toBe("C:\\isolated\\codex-home\\config.toml");
    expect(codexConfigPath({
      environment: {},
      homeDirectory: "C:\\isolated\\user-home",
      platform: "win32",
    })).toBe("C:\\isolated\\user-home\\.codex\\config.toml");
  });

  it("preserves unrelated TOML and comments while adding a marked block", async () => {
    const configPath = await createConfigPath();
    const original = [
      "# User comment stays byte-for-byte",
      'model = "gpt-5.4"',
      "",
      "[features]",
      "multi_agent = true # keep this comment",
      "",
    ].join("\n");
    await writeFile(configPath, original, "utf8");
    const manager = createCodexConfigManager({ configPath });

    await manager.connect({
      bridgeExecutable: "C:\\Program Files\\IntentArc Bridge.exe",
      connectionId: "connection with spaces",
    });

    const written = await readFile(configPath, "utf8");
    expect(written.startsWith(original)).toBe(true);
    expect(written).toContain(CODEX_INTENTARC_BLOCK_START);
    expect(written).toContain(CODEX_INTENTARC_BLOCK_END);
    const parsed = parse(written) as {
      mcp_servers?: {
        intentarc?: { command?: string; args?: string[] };
      };
    };
    expect(parsed.mcp_servers?.intentarc).toEqual({
      command: "C:\\Program Files\\IntentArc Bridge.exe",
      args: ["--connection", "connection with spaces"],
    });
  });

  it("backs up the original before changing it", async () => {
    const configPath = await createConfigPath();
    const original = 'model = "gpt-5.4"\n';
    await writeFile(configPath, original, "utf8");

    await createCodexConfigManager({ configPath }).connect({
      bridgeExecutable: "C:\\IntentArc Bridge.exe",
      connectionId: "connection-1",
    });

    const files = await readdir(join(configPath, ".."));
    const backup = files.find((name) =>
      name.startsWith("config.toml.intentarc-backup-")
    );
    expect(backup).toBeDefined();
    expect(await readFile(join(configPath, "..", backup!), "utf8")).toBe(original);
  });

  it("refuses an unmanaged intentarc table without changing the file", async () => {
    const configPath = await createConfigPath();
    const original = [
      "[mcp_servers.intentarc]",
      'command = "someone-else"',
      'args = ["serve"]',
      "",
    ].join("\n");
    await writeFile(configPath, original, "utf8");

    await expect(createCodexConfigManager({ configPath }).connect({
      bridgeExecutable: "C:\\IntentArc Bridge.exe",
      connectionId: "connection-1",
    })).rejects.toMatchObject({ code: "configuration_conflict" });
    expect(await readFile(configPath, "utf8")).toBe(original);
    expect(await readdir(join(configPath, ".."))).toEqual(["config.toml"]);
  });

  it("updates only the existing IntentArc-owned block", async () => {
    const configPath = await createConfigPath();
    const prefix = '# before\nmodel = "gpt-5.4"\n\n';
    const suffix = '\n# after\n[features]\nmulti_agent = true\n';
    const original = [
      prefix,
      CODEX_INTENTARC_BLOCK_START,
      "[mcp_servers.intentarc]",
      'command = "C:\\\\Old Bridge.exe"',
      'args = ["--connection", "old"]',
      CODEX_INTENTARC_BLOCK_END,
      suffix,
    ].join("\n");
    await writeFile(configPath, original, "utf8");

    await createCodexConfigManager({ configPath }).connect({
      bridgeExecutable: "C:\\New Bridge.exe",
      connectionId: "new",
    });

    const written = await readFile(configPath, "utf8");
    expect(written.slice(0, written.indexOf(CODEX_INTENTARC_BLOCK_START))).toBe(
      original.slice(0, original.indexOf(CODEX_INTENTARC_BLOCK_START)),
    );
    expect(written.slice(
      written.indexOf(CODEX_INTENTARC_BLOCK_END) +
        CODEX_INTENTARC_BLOCK_END.length,
    )).toBe(
      original.slice(
        original.indexOf(CODEX_INTENTARC_BLOCK_END) +
          CODEX_INTENTARC_BLOCK_END.length,
      ),
    );
    expect(written).toContain('"new"');
  });

  it("restores the original when post-write validation fails", async () => {
    const configPath = await createConfigPath();
    const original = '# original\nmodel = "gpt-5.4"\n';
    await writeFile(configPath, original, "utf8");
    let validations = 0;
    const manager = createCodexConfigManager({
      configPath,
      validateWrittenConfig: () => {
        validations += 1;
        throw new Error("validation failed");
      },
    });

    await expect(manager.connect({
      bridgeExecutable: "C:\\IntentArc Bridge.exe",
      connectionId: "connection-1",
    })).rejects.toMatchObject({ code: "configuration_invalid" });

    expect(validations).toBe(1);
    expect(await readFile(configPath, "utf8")).toBe(original);
  });

  it("preserves a concurrent unrelated comment written before apply returns while reverting its entry", async () => {
    const configPath = await createConfigPath();
    const original = '# original\nmodel = "gpt-5.4"\n';
    await writeFile(configPath, original, "utf8");
    const transaction = await createCodexConfigManager({
      configPath,
      validateWrittenConfig: (source) => {
        writeFileSync(
          configPath,
          `${source.replace("gpt-5.4", "gpt-5.6")}# concurrent user comment\n`,
          "utf8",
        );
      },
    }).prepareConnection({
      bridgeExecutable: "C:\\New\\IntentArc Bridge.exe",
      connectionId: "new-connection",
    });

    await transaction.apply();
    await transaction.rollback();

    const restored = await readFile(configPath, "utf8");
    expect(restored).toBe(
      '# original\nmodel = "gpt-5.6"\n# concurrent user comment\n',
    );
    expect(
      (parse(restored) as { mcp_servers?: { intentarc?: unknown } })
        .mcp_servers?.intentarc,
    ).toBeUndefined();
  });

  it("removes an uncontended new entry and restores an absent config path", async () => {
    const configPath = await createConfigPath();
    const transaction = await createCodexConfigManager({
      configPath,
    }).prepareConnection({
      bridgeExecutable: "C:\\New\\IntentArc Bridge.exe",
      connectionId: "new-connection",
    });

    await transaction.apply();
    await transaction.rollback();

    await expect(lstat(configPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses compensation when the IntentArc entry changes before apply returns", async () => {
    const configPath = await createConfigPath();
    const original = '# original\nmodel = "gpt-5.4"\n';
    await writeFile(configPath, original, "utf8");
    let concurrent = "";
    const transaction = await createCodexConfigManager({
      configPath,
      validateWrittenConfig: (source) => {
        concurrent = source.replace("new-connection", "concurrent-connection");
        writeFileSync(configPath, concurrent, "utf8");
      },
    }).prepareConnection({
      bridgeExecutable: "C:\\New\\IntentArc Bridge.exe",
      connectionId: "new-connection",
    });

    await transaction.apply();

    await expect(transaction.rollback()).rejects.toMatchObject({
      code: "compensation_conflict",
    });
    expect(await readFile(configPath, "utf8")).toBe(concurrent);
  });

  it("restores an exact disabled CLI-owned snapshot after an attempted repair", async () => {
    const configPath = await createConfigPath();
    const transaction = await prepareExternalRepair(configPath);

    await transaction.rollback();

    expect(await readFile(configPath, "utf8")).toBe(disabledOriginal);
  });

  it("preserves a concurrent unrelated comment while restoring the prior entry", async () => {
    const configPath = await createConfigPath();
    const transaction = await prepareExternalRepair(configPath);
    const concurrent = `${attemptedConfig}# concurrent user comment\n`;
    await writeFile(configPath, concurrent, "utf8");

    await transaction.rollback();

    expect(await readFile(configPath, "utf8")).toBe(
      `${disabledOriginal}# concurrent user comment\n`,
    );
  });

  it("refuses apply when an unrelated comment changes after prepare", async () => {
    const configPath = await createConfigPath();
    const original = [
      CODEX_INTENTARC_BLOCK_START,
      "[mcp_servers.intentarc]",
      'command = "C:\\\\Old\\\\IntentArc Bridge.exe"',
      'args = ["--connection", "old-connection"]',
      CODEX_INTENTARC_BLOCK_END,
      "",
    ].join("\n");
    await writeFile(configPath, original, "utf8");
    const transaction = await createCodexConfigManager({
      configPath,
    }).prepareConnection({
      bridgeExecutable: "C:\\New\\IntentArc Bridge.exe",
      connectionId: "new-connection",
    });
    const concurrent = `${original}# concurrent user comment\n`;
    await writeFile(configPath, concurrent, "utf8");

    await expect(transaction.apply()).rejects.toMatchObject({
      code: "compensation_conflict",
    });
    await expect(transaction.rollback()).resolves.toBeUndefined();

    expect(await readFile(configPath, "utf8")).toBe(concurrent);
  });

  it("refuses rollback after an unmanaged replacement", async () => {
    const configPath = await createConfigPath();
    const transaction = await prepareExternalRepair(configPath);
    const unmanaged = [
      'model = "gpt-5.6"',
      "",
      "[mcp_servers.intentarc]",
      'command = "someone-else"',
      'args = ["serve"]',
      "",
    ].join("\n");
    await writeFile(configPath, unmanaged, "utf8");

    await expect(transaction.rollback()).rejects.toMatchObject({
      code: "compensation_conflict",
    });

    expect(await readFile(configPath, "utf8")).toBe(unmanaged);
  });

  it("refuses rollback after delete and recreate even with identical bytes", async () => {
    const configPath = await createConfigPath();
    const original = [
      CODEX_INTENTARC_BLOCK_START,
      "[mcp_servers.intentarc]",
      'command = "C:\\\\Old\\\\IntentArc Bridge.exe"',
      'args = ["--connection", "old-connection"]',
      "enabled = false",
      CODEX_INTENTARC_BLOCK_END,
      "",
    ].join("\n");
    await writeFile(configPath, original, "utf8");
    const transaction = await createCodexConfigManager({
      configPath,
    }).prepareConnection({
      bridgeExecutable: "C:\\New\\IntentArc Bridge.exe",
      connectionId: "new-connection",
    });
    await transaction.apply();
    const attempted = await readFile(configPath, "utf8");
    await rm(configPath);
    await writeFile(configPath, attempted, "utf8");

    await expect(transaction.rollback()).rejects.toMatchObject({
      code: "compensation_conflict",
    });

    expect(await readFile(configPath, "utf8")).toBe(attempted);
  });

  it("restores only the entry after an unrelated metadata change", async () => {
    const configPath = await createConfigPath();
    const transaction = await prepareExternalRepair(configPath);
    await utimes(configPath, new Date(0), new Date(0));

    await transaction.rollback();

    expect(await readFile(configPath, "utf8")).toBe(disabledOriginal);
  });

  it("refuses rollback when the config path becomes a symlink", async () => {
    const configPath = await createConfigPath();
    const transaction = await prepareExternalRepair(configPath);
    const targetDirectory = join(configPath, "..", "replacement");
    const targetPath = join(targetDirectory, "marker.toml");
    const replacement = 'model = "replacement"\n';
    await mkdir(targetDirectory);
    await writeFile(targetPath, replacement, "utf8");
    await rm(configPath);
    await symlink(targetDirectory, configPath, "junction");

    await expect(transaction.rollback()).rejects.toMatchObject({
      code: "compensation_conflict",
    });

    expect((await lstat(configPath)).isSymbolicLink()).toBe(true);
    expect(await readFile(targetPath, "utf8")).toBe(replacement);
  });

  it("removes only a marked IntentArc-owned block", async () => {
    const configPath = await createConfigPath();
    const prefix = '# before\nmodel = "gpt-5.4"\n\n';
    const suffix = '\n\n# after\n[features]\nmulti_agent = true\n';
    await writeFile(
      configPath,
      [
        prefix,
        CODEX_INTENTARC_BLOCK_START,
        "[mcp_servers.intentarc]",
        'command = "C:\\\\IntentArc Bridge.exe"',
        'args = ["--connection", "one"]',
        CODEX_INTENTARC_BLOCK_END,
        suffix,
      ].join("\n"),
      "utf8",
    );

    await createCodexConfigManager({ configPath }).remove();

    expect(await readFile(configPath, "utf8")).toBe(`${prefix}${suffix}`);
  });

  it("rejects invalid existing TOML before creating a backup or writing", async () => {
    const configPath = await createConfigPath();
    const original = "[features\nbroken = true";
    await writeFile(configPath, original, "utf8");

    await expect(createCodexConfigManager({ configPath }).connect({
      bridgeExecutable: "C:\\IntentArc Bridge.exe",
      connectionId: "connection-1",
    })).rejects.toMatchObject({ code: "configuration_invalid" });

    expect(await readFile(configPath, "utf8")).toBe(original);
    expect(await readdir(join(configPath, ".."))).toEqual(["config.toml"]);
  });
});
