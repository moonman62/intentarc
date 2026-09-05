import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { validateManualClientLabel } from "../domain/manual-client-label.js";

const SETTINGS_FILE_NAME = "settings.json";
const MAX_SETTINGS_BYTES = 1024 * 1024;

export interface DesktopConnectionBase {
  readonly id: string;
  readonly profileId: string;
  readonly profileToken: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DesktopManagedConnection extends DesktopConnectionBase {
  readonly kind: "managed";
  readonly adapterId: "codex" | "claude-code";
}

export interface DesktopManualConnection extends DesktopConnectionBase {
  readonly kind: "manual-mcp";
  readonly label: string;
}

export type DesktopConnection =
  | DesktopManagedConnection
  | DesktopManualConnection;

export interface DesktopSettings {
  schemaVersion: 2;
  archivePath: string | null;
  onboardingCompleted: boolean;
  connections: DesktopConnection[];
}

export interface DesktopSettingsStore {
  read(): DesktopSettings;
  write(settings: DesktopSettings): void;
}

const defaultSettings = (): DesktopSettings => ({
  schemaVersion: 2,
  archivePath: null,
  onboardingCompleted: false,
  connections: [],
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasOnlyKeys = (
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean => Object.keys(value).every((key) => allowed.includes(key));

const isAbsoluteArchivePath = (value: string): boolean => isAbsolute(value);

const invalidSettings = (reason: string): never => {
  throw new Error(`Invalid desktop settings: ${reason}`);
};

const connectionBase = (
  value: Record<string, unknown>,
): DesktopConnectionBase => {
  if (
    typeof value.id !== "string" ||
    typeof value.profileId !== "string" ||
    typeof value.profileToken !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return invalidSettings("connection has invalid fields");
  }

  return {
    id: value.id,
    profileId: value.profileId,
    profileToken: value.profileToken,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
};

const parseV1Connection = (value: unknown): DesktopManagedConnection => {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "id",
    "adapterId",
    "profileId",
    "profileToken",
    "createdAt",
    "updatedAt",
  ])) {
    return invalidSettings("connection has an unknown or invalid shape");
  }

  if (value.adapterId !== "codex" && value.adapterId !== "claude-code") {
    return invalidSettings("connection has invalid fields");
  }

  return {
    ...connectionBase(value),
    kind: "managed",
    adapterId: value.adapterId,
  };
};

const parseV2Connection = (value: unknown): DesktopConnection => {
  if (!isRecord(value)) {
    return invalidSettings("connection has an unknown or invalid shape");
  }

  if (value.kind === "managed") {
    if (!hasOnlyKeys(value, [
      "id",
      "kind",
      "adapterId",
      "profileId",
      "profileToken",
      "createdAt",
      "updatedAt",
    ])) {
      return invalidSettings("managed connection has an unknown or invalid shape");
    }
    if (value.adapterId !== "codex" && value.adapterId !== "claude-code") {
      return invalidSettings("managed connection has invalid fields");
    }
    return {
      ...connectionBase(value),
      kind: "managed",
      adapterId: value.adapterId,
    };
  }

  if (value.kind === "manual-mcp") {
    if (!hasOnlyKeys(value, [
      "id",
      "kind",
      "label",
      "profileId",
      "profileToken",
      "createdAt",
      "updatedAt",
    ])) {
      return invalidSettings("manual connection has an unknown or invalid shape");
    }
    if (typeof value.label !== "string") {
      return invalidSettings("manual connection label is invalid");
    }
    const labelValidation = validateManualClientLabel(value.label);
    if (!labelValidation.valid) {
      return invalidSettings("manual connection label is invalid");
    }
    return {
      ...connectionBase(value),
      kind: "manual-mcp",
      label: labelValidation.label,
    };
  }

  return invalidSettings("connection kind is invalid");
};

const parseSettings = (value: unknown): DesktopSettings => {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "schemaVersion",
    "archivePath",
    "onboardingCompleted",
    "connections",
  ])) {
    return invalidSettings("document has an unknown or invalid shape");
  }

  if (
    (value.schemaVersion !== 1 && value.schemaVersion !== 2) ||
    typeof value.onboardingCompleted !== "boolean"
  ) {
    return invalidSettings("schema version or onboarding status is invalid");
  }
  if (
    value.archivePath !== null &&
    (typeof value.archivePath !== "string" || !isAbsoluteArchivePath(value.archivePath))
  ) {
    return invalidSettings("archive path must be absolute");
  }
  if (!Array.isArray(value.connections)) {
    return invalidSettings("connections must be an array");
  }

  const connections = value.connections.map(
    value.schemaVersion === 1 ? parseV1Connection : parseV2Connection,
  );
  const ids = new Set(connections.map((connection) => connection.id));
  if (ids.size !== connections.length) return invalidSettings("duplicate connection id");

  return {
    schemaVersion: 2,
    archivePath: value.archivePath,
    onboardingCompleted: value.onboardingCompleted,
    connections,
  };
};

const assertSafeSettingsFile = (settingsPath: string): void => {
  if (!existsSync(settingsPath)) return;

  const metadata = lstatSync(settingsPath);
  if (metadata.isSymbolicLink()) invalidSettings("settings path is a symbolic link");
  if (!metadata.isFile()) invalidSettings("settings path is not a regular file");
  if (metadata.size > MAX_SETTINGS_BYTES) invalidSettings("settings file is too large");
};

const readSettingsFile = (settingsPath: string): string => {
  const checkedMetadata = lstatSync(settingsPath);
  if (checkedMetadata.isSymbolicLink()) invalidSettings("settings path is a symbolic link");
  if (!checkedMetadata.isFile()) invalidSettings("settings path is not a regular file");

  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      settingsPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const openedMetadata = fstatSync(descriptor);
    const currentMetadata = lstatSync(settingsPath);
    if (currentMetadata.isSymbolicLink()) {
      return invalidSettings("settings path is a symbolic link");
    }
    if (
      !openedMetadata.isFile() ||
      openedMetadata.dev !== checkedMetadata.dev ||
      openedMetadata.ino !== checkedMetadata.ino
    ) {
      return invalidSettings("settings file changed during read");
    }
    if (openedMetadata.size > MAX_SETTINGS_BYTES) {
      return invalidSettings("settings file is too large");
    }
    const buffer = Buffer.alloc(MAX_SETTINGS_BYTES + 1);
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_SETTINGS_BYTES) {
      return invalidSettings("settings file is too large");
    }
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
};

const readSettings = (settingsPath: string): DesktopSettings => {
  if (!existsSync(settingsPath)) return defaultSettings();

  try {
    return parseSettings(JSON.parse(readSettingsFile(settingsPath)));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Invalid desktop settings:")) {
      throw error;
    }
    return invalidSettings("file is not valid JSON");
  }
};

const writeSettingsAtomically = (settingsPath: string, settings: DesktopSettings): void => {
  const serialized = JSON.stringify(parseSettings(settings));
  if (Buffer.byteLength(serialized, "utf8") > MAX_SETTINGS_BYTES) {
    invalidSettings("settings file is too large");
  }
  const temporaryPath = `${settingsPath}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;

  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, serialized, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, settingsPath);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    throw error;
  }
};

export const createDesktopSettingsStore = (root: string): DesktopSettingsStore => {
  const settingsPath = join(root, SETTINGS_FILE_NAME);

  return {
    read: () => readSettings(settingsPath),
    write: (settings) => {
      mkdirSync(root, { recursive: true, mode: 0o700 });
      assertSafeSettingsFile(settingsPath);
      writeSettingsAtomically(settingsPath, settings);
    },
  };
};
