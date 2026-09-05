import { randomUUID } from "node:crypto";
import {
  constants,
  link,
  lstat,
  mkdir,
  open,
  rename,
  rm,
} from "node:fs/promises";
import {
  basename,
  dirname,
  join,
  posix,
  win32,
} from "node:path";
import { homedir } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { parse, stringify } from "smol-toml";
import {
  AiAdapterError,
  type AiConnectionStatus,
} from "./types.js";

export const CODEX_INTENTARC_BLOCK_START =
  "# >>> IntentArc managed MCP server >>>";
export const CODEX_INTENTARC_BLOCK_END =
  "# <<< IntentArc managed MCP server <<<";

export interface CodexConfigConnection {
  readonly bridgeExecutable: string;
  readonly connectionId: string;
}

export interface CodexConfigConnectionAttempt {
  apply(): Promise<void>;
  rollback(expectedEnabled?: boolean): Promise<void>;
}

export interface CodexConfigManager {
  inspect(): Promise<AiConnectionStatus>;
  prepareConnection(
    input: CodexConfigConnection,
  ): Promise<CodexConfigConnectionAttempt>;
  connect(input: CodexConfigConnection): Promise<void>;
  remove(): Promise<void>;
}

interface ExpectedIntentArcConfig {
  readonly command: string;
  readonly args: readonly ["--connection", string];
}

export interface CreateCodexConfigManagerOptions {
  readonly configPath?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly homeDirectory?: string;
  readonly platform?: NodeJS.Platform;
  readonly validateWrittenConfig?: (
    source: string,
    expected: ExpectedIntentArcConfig | null,
  ) => void;
}

export interface CodexConfigPathOptions {
  readonly environment: NodeJS.ProcessEnv;
  readonly homeDirectory: string;
  readonly platform: NodeJS.Platform;
}

export const codexConfigPath = (
  options: CodexConfigPathOptions,
): string => {
  const pathApi = options.platform === "win32" ? win32 : posix;
  const configuredHome = options.environment.CODEX_HOME?.trim();
  const root =
    configuredHome && configuredHome.length > 0
      ? configuredHome
      : pathApi.join(options.homeDirectory, ".codex");
  if (!pathApi.isAbsolute(root)) {
    throw new AiAdapterError("configuration_invalid");
  }
  return pathApi.join(root, "config.toml");
};

interface ManagedBlock {
  readonly start: number;
  readonly end: number;
}

interface LoadedConfig {
  readonly exists: boolean;
  readonly source: string;
  readonly parsed: Record<string, unknown>;
  readonly block: ManagedBlock | null;
  readonly intentarc: unknown;
}

interface SourceRange {
  readonly start: number;
  readonly end: number;
}

interface IntentArcEntryState {
  readonly value: unknown;
  readonly syntax: readonly SourceRange[];
  readonly managedBlock: ManagedBlock | null;
}

interface ConfigFileMetadata {
  readonly device: bigint;
  readonly inode: bigint;
  readonly mode: bigint;
  readonly links: bigint;
  readonly user: bigint;
  readonly group: bigint;
  readonly specialDevice: bigint;
  readonly size: bigint;
  readonly modifiedNanoseconds: bigint;
  readonly changedNanoseconds: bigint;
  readonly createdNanoseconds: bigint;
}

type ConfigFileSnapshot =
  | { readonly exists: false }
  | {
      readonly exists: true;
      readonly source: string;
      readonly metadata: ConfigFileMetadata;
    };

const hasErrorCode = (
  error: unknown,
  codes: readonly string[],
): error is NodeJS.ErrnoException =>
  error instanceof Error &&
  typeof (error as NodeJS.ErrnoException).code === "string" &&
    codes.includes((error as NodeJS.ErrnoException).code!);

const metadataFor = (
  entry: Awaited<ReturnType<typeof lstat>>,
): ConfigFileMetadata => {
  const value = entry as unknown as {
    readonly dev: bigint;
    readonly ino: bigint;
    readonly mode: bigint;
    readonly nlink: bigint;
    readonly uid: bigint;
    readonly gid: bigint;
    readonly rdev: bigint;
    readonly size: bigint;
    readonly mtimeNs: bigint;
    readonly ctimeNs: bigint;
    readonly birthtimeNs: bigint;
  };
  return {
    device: value.dev,
    inode: value.ino,
    mode: value.mode,
    links: value.nlink,
    user: value.uid,
    group: value.gid,
    specialDevice: value.rdev,
    size: value.size,
    modifiedNanoseconds: value.mtimeNs,
    changedNanoseconds: value.ctimeNs,
    createdNanoseconds: value.birthtimeNs,
  };
};

const sameIdentity = (
  left: ConfigFileMetadata,
  right: ConfigFileMetadata,
): boolean =>
  left.device === right.device &&
  left.inode === right.inode;

const sameMetadata = (
  left: ConfigFileMetadata,
  right: ConfigFileMetadata,
): boolean =>
  sameIdentity(left, right) &&
  left.mode === right.mode &&
  left.links === right.links &&
  left.user === right.user &&
  left.group === right.group &&
  left.specialDevice === right.specialDevice &&
  left.size === right.size &&
  left.modifiedNanoseconds === right.modifiedNanoseconds &&
  left.changedNanoseconds === right.changedNanoseconds &&
  left.createdNanoseconds === right.createdNanoseconds;

const sameSnapshot = (
  left: ConfigFileSnapshot,
  right: ConfigFileSnapshot,
): boolean =>
  left.exists === right.exists &&
  (!left.exists ||
    (right.exists &&
      left.source === right.source &&
      sameMetadata(left.metadata, right.metadata)));

const snapshotError = (
  code: "configuration_conflict" | "compensation_conflict",
  cause?: unknown,
): AiAdapterError =>
  new AiAdapterError(
    code,
    {},
    cause === undefined ? undefined : { cause },
  );

const readConfigSnapshot = async (
  configPath: string,
  conflictCode:
    | "configuration_conflict"
    | "compensation_conflict" = "configuration_conflict",
): Promise<ConfigFileSnapshot> => {
  let checked;
  try {
    checked = await lstat(configPath, { bigint: true });
  } catch (error) {
    if (hasErrorCode(error, ["ENOENT"])) return { exists: false };
    if (hasErrorCode(error, ["EACCES", "EPERM"])) {
      throw new AiAdapterError("access_denied", {}, { cause: error });
    }
    throw snapshotError(conflictCode, error);
  }
  if (checked.isSymbolicLink() || !checked.isFile()) {
    throw snapshotError(conflictCode);
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      configPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const openedBefore = await handle.stat({ bigint: true });
    const currentBefore = await lstat(configPath, { bigint: true });
    if (
      !openedBefore.isFile() ||
      currentBefore.isSymbolicLink() ||
      !currentBefore.isFile()
    ) {
      throw snapshotError(conflictCode);
    }
    const checkedMetadata = metadataFor(checked);
    const openedBeforeMetadata = metadataFor(openedBefore);
    const currentBeforeMetadata = metadataFor(currentBefore);
    if (
      !sameIdentity(checkedMetadata, openedBeforeMetadata) ||
      !sameIdentity(openedBeforeMetadata, currentBeforeMetadata)
    ) {
      throw snapshotError(conflictCode);
    }

    const content = await handle.readFile();
    const openedAfter = await handle.stat({ bigint: true });
    const currentAfter = await lstat(configPath, { bigint: true });
    if (
      currentAfter.isSymbolicLink() ||
      !currentAfter.isFile()
    ) {
      throw snapshotError(conflictCode);
    }
    const openedAfterMetadata = metadataFor(openedAfter);
    const currentAfterMetadata = metadataFor(currentAfter);
    if (
      !sameMetadata(openedBeforeMetadata, openedAfterMetadata) ||
      !sameMetadata(openedAfterMetadata, currentAfterMetadata) ||
      openedAfterMetadata.size !== BigInt(content.byteLength)
    ) {
      throw snapshotError(conflictCode);
    }
    return {
      exists: true,
      source: content.toString("utf8"),
      metadata: openedAfterMetadata,
    };
  } catch (error) {
    if (error instanceof AiAdapterError) throw error;
    if (hasErrorCode(error, ["EACCES", "EPERM", "ELOOP"])) {
      if (hasErrorCode(error, ["ELOOP"])) {
        throw snapshotError(conflictCode, error);
      }
      throw new AiAdapterError("access_denied", {}, { cause: error });
    }
    if (hasErrorCode(error, ["ENOENT"])) {
      throw snapshotError(conflictCode, error);
    }
    throw snapshotError(conflictCode, error);
  } finally {
    await handle?.close();
  }
};

const readConfig = async (
  configPath: string,
): Promise<{ exists: boolean; source: string }> => {
  const snapshot = await readConfigSnapshot(configPath);
  return snapshot.exists
    ? { exists: true, source: snapshot.source }
    : { exists: false, source: "" };
};

const locateManagedBlock = (source: string): ManagedBlock | null => {
  const start = source.indexOf(CODEX_INTENTARC_BLOCK_START);
  const endMarkerStart = source.indexOf(
    CODEX_INTENTARC_BLOCK_END,
    Math.max(0, start + CODEX_INTENTARC_BLOCK_START.length),
  );
  const hasStart = start >= 0;
  const hasEnd = endMarkerStart >= 0;
  const duplicateStart =
    hasStart &&
    source.indexOf(
      CODEX_INTENTARC_BLOCK_START,
      start + CODEX_INTENTARC_BLOCK_START.length,
    ) >= 0;
  const duplicateEnd =
    hasEnd &&
    source.indexOf(
      CODEX_INTENTARC_BLOCK_END,
      endMarkerStart + CODEX_INTENTARC_BLOCK_END.length,
    ) >= 0;

  if (hasStart !== hasEnd || duplicateStart || duplicateEnd) {
    throw new AiAdapterError("configuration_conflict");
  }
  if (!hasStart || !hasEnd) return null;
  if (endMarkerStart < start) {
    throw new AiAdapterError("configuration_conflict");
  }
  return {
    start,
    end: endMarkerStart + CODEX_INTENTARC_BLOCK_END.length,
  };
};

const intentarcConfigFrom = (parsed: Record<string, unknown>): unknown => {
  const servers = parsed.mcp_servers;
  if (
    servers === null ||
    typeof servers !== "object" ||
    Array.isArray(servers)
  ) {
    return undefined;
  }
  return (servers as Record<string, unknown>).intentarc;
};

const intentArcTableHeaderPattern =
  /^[ \t]*\[[ \t]*(?:mcp_servers|"mcp_servers"|'mcp_servers')[ \t]*\.[ \t]*(?:intentarc|"intentarc"|'intentarc')[ \t]*\][^\r\n]*(?:\r\n|\n|$)/gm;
const tableHeaderPattern = /^[ \t]*\[\[?[^\r\n]*(?:\r\n|\n|$)/gm;

const standardIntentArcTableRange = (
  source: string,
): SourceRange | null => {
  const matches = [...source.matchAll(intentArcTableHeaderPattern)];
  if (matches.length === 0) return null;
  if (matches.length !== 1 || matches[0]?.index === undefined) {
    throw new AiAdapterError("configuration_conflict");
  }
  const start = matches[0].index;
  const headerEnd = start + matches[0][0].length;
  tableHeaderPattern.lastIndex = headerEnd;
  const next = tableHeaderPattern.exec(source);
  return {
    start,
    end: next?.index ?? source.length,
  };
};

const syntaxRangesIn = (
  source: string,
  range: SourceRange,
  managed: boolean,
): readonly SourceRange[] => {
  const ranges: SourceRange[] = [];
  let cursor = range.start;
  while (cursor < range.end) {
    const newline = source.indexOf("\n", cursor);
    const end = newline >= 0 && newline < range.end
      ? newline + 1
      : range.end;
    const trimmed = source.slice(cursor, end).trim();
    if (
      trimmed.length > 0 &&
      (
        !trimmed.startsWith("#") ||
        (managed &&
          (trimmed === CODEX_INTENTARC_BLOCK_START ||
            trimmed === CODEX_INTENTARC_BLOCK_END))
      )
    ) {
      ranges.push({ start: cursor, end });
    }
    cursor = end;
  }
  return ranges;
};

const entryStateFromSource = (
  source: string,
  conflictCode: "configuration_conflict" | "compensation_conflict",
  invalidCode:
    | "configuration_invalid"
    | "configuration_conflict"
    | "compensation_conflict" = conflictCode,
): IntentArcEntryState => {
  let parsed: Record<string, unknown>;
  try {
    parsed = parse(source) as Record<string, unknown>;
  } catch (error) {
    throw new AiAdapterError(invalidCode, {}, { cause: error });
  }
  let block: ManagedBlock | null;
  try {
    block = locateManagedBlock(source);
  } catch (error) {
    throw new AiAdapterError(conflictCode, {}, { cause: error });
  }
  const value = intentarcConfigFrom(parsed);
  if (value === undefined) {
    if (block !== null) {
      throw new AiAdapterError(conflictCode);
    }
    return { value: undefined, syntax: [], managedBlock: null };
  }

  let region: SourceRange | null;
  try {
    region = block ?? standardIntentArcTableRange(source);
  } catch (error) {
    throw new AiAdapterError(conflictCode, {}, { cause: error });
  }
  if (region === null) {
    throw new AiAdapterError(conflictCode);
  }
  return {
    value,
    syntax: syntaxRangesIn(source, region, block !== null),
    managedBlock: block,
  };
};

const normalizedEntry = (value: unknown): unknown => {
  if (
    value === undefined ||
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return value;
  }
  const entry = value as Record<string, unknown>;
  return {
    ...entry,
    enabled: entry.enabled ?? true,
  };
};

const sameEntry = (left: unknown, right: unknown): boolean =>
  isDeepStrictEqual(normalizedEntry(left), normalizedEntry(right));

const matchesExpectedEntry = (
  value: unknown,
  input: CodexConfigConnection,
  expectedEnabled: boolean,
): boolean => {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  const keys = Object.keys(entry).sort();
  if (
    !isDeepStrictEqual(
      keys,
      entry.enabled === undefined
        ? ["args", "command"]
        : ["args", "command", "enabled"],
    ) ||
    entry.command !== input.bridgeExecutable ||
    !isDeepStrictEqual(
      entry.args,
      ["--connection", input.connectionId],
    ) ||
    (entry.enabled ?? true) !== expectedEnabled
  ) {
    return false;
  }
  return true;
};

const syntaxSource = (
  source: string,
  syntax: readonly SourceRange[],
): string => syntax.map(({ start, end }) => source.slice(start, end)).join("");

const sourceWithRestoredEntry = (
  currentSource: string,
  current: IntentArcEntryState,
  originalSource: string,
  original: IntentArcEntryState,
): string => {
  if (current.syntax.length === 0) {
    throw new AiAdapterError("compensation_conflict");
  }
  if (
    current.managedBlock !== null &&
    original.syntax.length === 0
  ) {
    return sourceWithoutManagedBlock(
      currentSource,
      current.managedBlock,
    );
  }
  const rawReplacement = syntaxSource(originalSource, original.syntax);
  const replacement =
    rawReplacement.length > 0 && !rawReplacement.endsWith("\n")
      ? `${rawReplacement}${currentSource.includes("\r\n") ? "\r\n" : "\n"}`
      : rawReplacement;
  let result = currentSource.slice(0, current.syntax[0]!.start);
  result += replacement;
  let cursor = current.syntax[0]!.end;
  for (const range of current.syntax.slice(1)) {
    result += currentSource.slice(cursor, range.start);
    cursor = range.end;
  }
  result += currentSource.slice(cursor);
  return result;
};

const sourceWithInsertedEntry = (
  currentSource: string,
  originalSource: string,
  original: IntentArcEntryState,
): string => {
  const entrySource = syntaxSource(originalSource, original.syntax);
  if (entrySource.length === 0) {
    throw new AiAdapterError("compensation_conflict");
  }
  const normalizedEntrySource = entrySource.endsWith("\n")
    ? entrySource
    : `${entrySource}\n`;
  if (currentSource.length === 0) return normalizedEntrySource;
  const separator = currentSource.endsWith("\n") ? "\n" : "\n\n";
  return `${currentSource}${separator}${normalizedEntrySource}`;
};

const loadedConfigFrom = (
  config: { readonly exists: boolean; readonly source: string },
): LoadedConfig => {
  let parsed: Record<string, unknown>;
  try {
    parsed = parse(config.source) as Record<string, unknown>;
  } catch (error) {
    throw new AiAdapterError("configuration_invalid", {}, { cause: error });
  }
  const block = locateManagedBlock(config.source);
  const intentarc = intentarcConfigFrom(parsed);
  if (block === null && intentarc !== undefined) {
    throw new AiAdapterError("configuration_conflict");
  }
  if (block !== null && intentarc === undefined) {
    throw new AiAdapterError("configuration_invalid");
  }
  return { ...config, parsed, block, intentarc };
};

const loadConfig = async (configPath: string): Promise<LoadedConfig> =>
  loadedConfigFrom(await readConfig(configPath));

const managedBlockSource = (input: CodexConfigConnection): string => {
  const table = stringify({
    mcp_servers: {
      intentarc: {
        command: input.bridgeExecutable,
        args: ["--connection", input.connectionId],
      },
    },
  }).trimEnd();
  return [
    CODEX_INTENTARC_BLOCK_START,
    table,
    CODEX_INTENTARC_BLOCK_END,
  ].join("\n");
};

const sourceWithManagedBlock = (
  loaded: LoadedConfig,
  input: CodexConfigConnection,
): string => {
  const block = managedBlockSource(input);
  if (loaded.block !== null) {
    return `${loaded.source.slice(0, loaded.block.start)}${block}${loaded.source.slice(loaded.block.end)}`;
  }
  if (loaded.source.length === 0) return `${block}\n`;
  const separator = loaded.source.endsWith("\n") ? "\n" : "\n\n";
  return `${loaded.source}${separator}${block}\n`;
};

const sourceWithoutManagedBlock = (
  source: string,
  block: ManagedBlock,
): string => {
  let before = source.slice(0, block.start);
  let after = source.slice(block.end);
  if (before.endsWith("\n") && after.startsWith("\n")) {
    before = before.slice(0, -1);
    after = after.slice(1);
  }
  return `${before}${after}`;
};

const writeDurableFile = async (
  path: string,
  source: string,
  exclusive: boolean,
): Promise<void> => {
  const handle = await open(path, exclusive ? "wx" : "w", 0o600);
  try {
    await handle.writeFile(source, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const createBackup = async (
  configPath: string,
  source: string,
): Promise<void> => {
  const backupPath = `${configPath}.intentarc-backup-${Date.now()}-${randomUUID()}`;
  try {
    await writeDurableFile(backupPath, source, true);
  } catch (error) {
    if (hasErrorCode(error, ["EACCES", "EPERM"])) {
      throw new AiAdapterError("access_denied", {}, { cause: error });
    }
    throw new AiAdapterError("configuration_failed", {}, { cause: error });
  }
};

const defaultValidateWrittenConfig = (
  source: string,
  expected: ExpectedIntentArcConfig | null,
): void => {
  const parsed = parse(source) as Record<string, unknown>;
  const intentarc = intentarcConfigFrom(parsed);
  if (expected === null) {
    if (intentarc !== undefined) {
      throw new Error("IntentArc MCP configuration remains after removal.");
    }
    return;
  }
  if (
    intentarc === null ||
    typeof intentarc !== "object" ||
    Array.isArray(intentarc)
  ) {
    throw new Error("IntentArc MCP configuration is unavailable.");
  }
  const actual = intentarc as Record<string, unknown>;
  if (
    actual.command !== expected.command ||
    !Array.isArray(actual.args) ||
    actual.args.length !== 2 ||
    actual.args[0] !== expected.args[0] ||
    actual.args[1] !== expected.args[1]
  ) {
    throw new Error("IntentArc MCP configuration validation failed.");
  }
};

const pathIsMissing = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if (hasErrorCode(error, ["ENOENT"])) return true;
    throw error;
  }
};

const restoreQuarantinedFile = async (
  quarantinedPath: string,
  configPath: string,
): Promise<void> => {
  if (!await pathIsMissing(configPath)) return;
  try {
    await link(quarantinedPath, configPath);
    await rm(quarantinedPath, { force: true });
  } catch {
    // A concurrently recreated path wins. The quarantined bytes are retained
    // for recovery rather than overwriting an identity we no longer own.
  }
};

const sameQuarantinedSnapshot = (
  snapshot: ConfigFileSnapshot,
  expected: ConfigFileSnapshot,
): boolean =>
  snapshot.exists &&
  expected.exists &&
  snapshot.source === expected.source &&
  sameIdentity(snapshot.metadata, expected.metadata) &&
  snapshot.metadata.mode === expected.metadata.mode &&
  snapshot.metadata.links === expected.metadata.links &&
  snapshot.metadata.user === expected.metadata.user &&
  snapshot.metadata.group === expected.metadata.group &&
  snapshot.metadata.specialDevice === expected.metadata.specialDevice &&
  snapshot.metadata.size === expected.metadata.size &&
  snapshot.metadata.modifiedNanoseconds ===
    expected.metadata.modifiedNanoseconds &&
  snapshot.metadata.createdNanoseconds === expected.metadata.createdNanoseconds;

const publishWithCompareAndSwap = async (
  configPath: string,
  expected: ConfigFileSnapshot,
  replacement: string | null,
  conflictCode: "configuration_conflict" | "compensation_conflict",
): Promise<ConfigFileSnapshot> => {
  const current = await readConfigSnapshot(
    configPath,
    conflictCode,
  );
  if (!sameSnapshot(current, expected)) {
    throw new AiAdapterError(conflictCode);
  }

  const directory = dirname(configPath);
  await mkdir(directory, { recursive: true });
  if (!current.exists) {
    if (replacement === null) return current;
    const temporaryPath = join(
      directory,
      `.${basename(configPath)}.intentarc-${randomUUID()}.tmp`,
    );
    try {
      await writeDurableFile(temporaryPath, replacement, true);
      try {
        await link(temporaryPath, configPath);
      } catch (error) {
        throw new AiAdapterError(conflictCode, {}, { cause: error });
      }
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => {});
    }
    const published = await readConfigSnapshot(configPath, conflictCode);
    if (!published.exists || published.source !== replacement) {
      throw new AiAdapterError(conflictCode);
    }
    return published;
  }

  const quarantinedPath = join(
    directory,
    `.${basename(configPath)}.intentarc-rollback-${randomUUID()}.guard`,
  );
  try {
    await rename(configPath, quarantinedPath);
  } catch (error) {
    throw new AiAdapterError(conflictCode, {}, { cause: error });
  }

  let quarantineOwned = true;
  try {
    const quarantined = await readConfigSnapshot(
      quarantinedPath,
      conflictCode,
    );
    if (!sameQuarantinedSnapshot(quarantined, expected)) {
      await restoreQuarantinedFile(quarantinedPath, configPath);
      quarantineOwned = false;
      throw new AiAdapterError(conflictCode);
    }

    if (replacement === null) {
      if (!await pathIsMissing(configPath)) {
        await rm(quarantinedPath);
        quarantineOwned = false;
        throw new AiAdapterError(conflictCode);
      }
      await rm(quarantinedPath);
      quarantineOwned = false;
      return { exists: false };
    }

    const temporaryPath = join(
      directory,
      `.${basename(configPath)}.intentarc-${randomUUID()}.tmp`,
    );
    try {
      await writeDurableFile(temporaryPath, replacement, true);
      try {
        await link(temporaryPath, configPath);
      } catch (error) {
        if (hasErrorCode(error, ["EEXIST"])) {
          await rm(quarantinedPath);
          quarantineOwned = false;
          throw new AiAdapterError(conflictCode, {}, {
            cause: error,
          });
        }
        throw error;
      }
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => {});
    }
    await rm(quarantinedPath);
    quarantineOwned = false;
    const published = await readConfigSnapshot(configPath, conflictCode);
    if (!published.exists || published.source !== replacement) {
      throw new AiAdapterError(conflictCode);
    }
    return published;
  } catch (error) {
    if (quarantineOwned) {
      await restoreQuarantinedFile(quarantinedPath, configPath);
    }
    if (error instanceof AiAdapterError) {
      if (error.code === conflictCode) throw error;
      throw new AiAdapterError(conflictCode, {}, { cause: error });
    }
    throw new AiAdapterError(conflictCode, {}, { cause: error });
  }
};

export const createCodexConfigManager = (
  options: CreateCodexConfigManagerOptions = {},
): CodexConfigManager => {
  const configPath =
    options.configPath ??
    codexConfigPath({
      environment: options.environment ?? process.env,
      homeDirectory: options.homeDirectory ?? homedir(),
      platform: options.platform ?? process.platform,
    });
  const validate =
    options.validateWrittenConfig ?? defaultValidateWrittenConfig;

  const prepareConnection = async (
    input: CodexConfigConnection,
  ): Promise<CodexConfigConnectionAttempt> => {
    const original = await readConfigSnapshot(configPath);
    const originalSource = original.exists ? original.source : "";
    const originalEntry = entryStateFromSource(
      originalSource,
      "configuration_conflict",
      "configuration_invalid",
    );
    let appliedIdentity: ConfigFileMetadata | undefined;

    const rollback = async (
      expectedEnabled = true,
    ): Promise<void> => {
      const current = await readConfigSnapshot(
        configPath,
        "compensation_conflict",
      );
      const currentSource = current.exists ? current.source : "";
      const currentEntry = entryStateFromSource(
        currentSource,
        "compensation_conflict",
      );
      if (sameEntry(currentEntry.value, originalEntry.value)) return;
      if (
        !current.exists ||
        !matchesExpectedEntry(currentEntry.value, input, expectedEnabled)
      ) {
        throw new AiAdapterError("compensation_conflict");
      }
      if (
        appliedIdentity !== undefined &&
        !sameIdentity(current.metadata, appliedIdentity)
      ) {
        throw new AiAdapterError("compensation_conflict");
      }

      const restoredSource = sourceWithRestoredEntry(
        current.source,
        currentEntry,
        originalSource,
        originalEntry,
      );
      const restoredEntry = entryStateFromSource(
        restoredSource,
        "compensation_conflict",
      );
      if (!sameEntry(restoredEntry.value, originalEntry.value)) {
        throw new AiAdapterError("compensation_conflict");
      }
      await publishWithCompareAndSwap(
        configPath,
        current,
        !original.exists && restoredSource.trim().length === 0
          ? null
          : restoredSource,
        "compensation_conflict",
      );
    };

    return {
      apply: async () => {
        const current = await readConfigSnapshot(
          configPath,
          "compensation_conflict",
        );
        if (!sameSnapshot(current, original)) {
          throw new AiAdapterError("compensation_conflict");
        }
        const loaded = loadedConfigFrom({
          exists: original.exists,
          source: originalSource,
        });
        if (loaded.exists) await createBackup(configPath, loaded.source);
        const expected: ExpectedIntentArcConfig = {
          command: input.bridgeExecutable,
          args: ["--connection", input.connectionId],
        };
        const published = await publishWithCompareAndSwap(
          configPath,
          current,
          sourceWithManagedBlock(loaded, input),
          "compensation_conflict",
        );
        if (!published.exists) {
          throw new AiAdapterError("configuration_failed");
        }
        appliedIdentity = published.metadata;
        try {
          validate(published.source, expected);
        } catch (error) {
          try {
            await rollback();
          } catch (restoreError) {
            throw new AiAdapterError("configuration_failed", {}, {
              cause: new AggregateError(
                [error, restoreError],
                "Codex configuration validation rollback failed.",
              ),
            });
          }
          throw new AiAdapterError("configuration_invalid", {}, {
            cause: error,
          });
        }
      },
      rollback,
    };
  };

  const connect = async (input: CodexConfigConnection): Promise<void> => {
    const attempt = await prepareConnection(input);
    await attempt.apply();
  };

  return {
    inspect: async () => {
      const loaded = await loadConfig(configPath);
      if (loaded.intentarc === undefined) return "not_connected";
      return loaded.block === null ? "unknown" : "connected";
    },
    prepareConnection,
    connect,
    remove: async () => {
      const original = await readConfigSnapshot(configPath);
      const loaded = loadedConfigFrom({
        exists: original.exists,
        source: original.exists ? original.source : "",
      });
      if (loaded.block === null) return;
      const originalEntry = entryStateFromSource(
        loaded.source,
        "configuration_conflict",
        "configuration_invalid",
      );
      await createBackup(configPath, loaded.source);
      const published = await publishWithCompareAndSwap(
        configPath,
        original,
        sourceWithoutManagedBlock(loaded.source, loaded.block),
        "configuration_conflict",
      );
      try {
        validate(published.exists ? published.source : "", null);
      } catch (error) {
        try {
          const current = await readConfigSnapshot(
            configPath,
            "compensation_conflict",
          );
          const currentSource = current.exists ? current.source : "";
          const currentEntry = entryStateFromSource(
            currentSource,
            "compensation_conflict",
          );
          if (!sameEntry(currentEntry.value, originalEntry.value)) {
            if (
              currentEntry.value !== undefined ||
              !published.exists ||
              !current.exists ||
              !sameIdentity(current.metadata, published.metadata)
            ) {
              throw new AiAdapterError("compensation_conflict");
            }
            const restoredSource = sourceWithInsertedEntry(
              current.source,
              loaded.source,
              originalEntry,
            );
            await publishWithCompareAndSwap(
              configPath,
              current,
              restoredSource,
              "compensation_conflict",
            );
          }
        } catch (restoreError) {
          throw new AiAdapterError("configuration_failed", {}, {
            cause: new AggregateError(
              [error, restoreError],
              "Codex configuration removal rollback failed.",
            ),
          });
        }
        throw new AiAdapterError("configuration_invalid", {}, {
          cause: error,
        });
      }
    },
  };
};
