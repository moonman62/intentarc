import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type BigIntStats,
} from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { RepositoryImportError } from "../import/errors.js";
import {
  MAX_TEXT_FILE_BYTES,
  resolveContainedPath,
} from "../import/filesystem-policy.js";

const HASH_CHUNK_BYTES = 64 * 1024;
export const MAX_PREVIEW_FILE_BYTES = 8 * 1024 * 1024;

export type RepositoryPathInspection =
  | {
    readonly kind: "file";
    readonly absolutePath: string;
    readonly status: BigIntStats;
  }
  | { readonly kind: "link"; readonly path: string }
  | { readonly kind: "unsupported" };

export type SafeRepositoryReadMode = "metadata" | "hash" | "content" | "preview";

export type SafeRepositoryFileRead =
  | {
    readonly kind: "file";
    readonly byteSize: number;
    readonly content: Buffer | null;
    readonly sha256: string | null;
  }
  | { readonly kind: "unsupported" };

export interface SafeFileReaderDependencies {
  readonly openFileForRead?: (path: string, flags: number) => number;
  readonly readFileChunk?: (
    descriptor: number,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ) => number;
  readonly resolveRealPath?: (path: string) => string;
}

interface ResolvedSafeFileReaderDependencies {
  readonly openFileForRead: (path: string, flags: number) => number;
  readonly readFileChunk: (
    descriptor: number,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ) => number;
  readonly resolveRealPath: (path: string) => string;
}

interface OpenedRepositoryFile {
  readonly status: BigIntStats;
  readonly byteSize: number;
}

interface FileReadAccumulator {
  readonly content: Buffer | null;
  readonly hash: ReturnType<typeof createHash>;
  readonly chunk: Buffer;
  readonly byteSize: number;
  position: number;
}

export const inspectRepositoryPath = (
  root: string,
  relativePath: string,
): RepositoryPathInspection => {
  const segments = relativePath.split("/");
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = resolveContainedPath(root, join(current, segments[index]!));
    let status: BigIntStats;
    try {
      status = lstatSync(current, { bigint: true });
    } catch {
      return { kind: "unsupported" };
    }
    if (status.isSymbolicLink()) {
      return { kind: "link", path: segments.slice(0, index + 1).join("/") };
    }
    if (index < segments.length - 1 && !status.isDirectory()) {
      return { kind: "unsupported" };
    }
    if (index === segments.length - 1) {
      return status.isFile()
        ? { kind: "file", absolutePath: current, status }
        : { kind: "unsupported" };
    }
  }
  return { kind: "unsupported" };
};

const sameFileSnapshot = (left: BigIntStats, right: BigIntStats): boolean =>
  left.isFile() &&
  right.isFile() &&
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.mode === right.mode &&
  left.size === right.size &&
  left.ctimeNs === right.ctimeNs &&
  left.mtimeNs === right.mtimeNs;

const realPathIsContained = (root: string, candidate: string): boolean => {
  const fromRoot = relative(
    process.platform === "win32" ? root.toLowerCase() : root,
    process.platform === "win32" ? candidate.toLowerCase() : candidate,
  );
  return fromRoot === "" ||
    (!isAbsolute(fromRoot) &&
      fromRoot !== ".." &&
      !fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
};

const repositoryRace = (): never => {
  throw new RepositoryImportError("unsupported_repository", {
    path: "repository",
  });
};

const resolveDependencies = (
  dependencies: SafeFileReaderDependencies,
): ResolvedSafeFileReaderDependencies => ({
  openFileForRead: dependencies.openFileForRead ?? openSync,
  readFileChunk: dependencies.readFileChunk ?? readSync,
  resolveRealPath: dependencies.resolveRealPath ?? realpathSync.native,
});

const validateOpenedRepositoryFile = (
  root: string,
  relativePath: string,
  inspected: Extract<RepositoryPathInspection, { readonly kind: "file" }>,
  descriptor: number,
  resolveRealPath: (path: string) => string,
): OpenedRepositoryFile => {
  const openedBefore = fstatSync(descriptor, { bigint: true });
  if (!sameFileSnapshot(inspected.status, openedBefore)) return repositoryRace();

  const postOpen = inspectRepositoryPath(root, relativePath);
  if (
    postOpen.kind !== "file" ||
    !sameFileSnapshot(openedBefore, postOpen.status) ||
    !realPathIsContained(root, resolveRealPath(postOpen.absolutePath))
  ) {
    return repositoryRace();
  }

  const byteSize = Number(openedBefore.size);
  if (!Number.isSafeInteger(byteSize) || byteSize < 0) return repositoryRace();
  return { status: openedBefore, byteSize };
};

const validateRepositoryFileAfterRead = (
  root: string,
  relativePath: string,
  descriptor: number,
  opened: OpenedRepositoryFile,
  resolveRealPath: (path: string) => string,
): void => {
  const openedAfter = fstatSync(descriptor, { bigint: true });
  const postRead = inspectRepositoryPath(root, relativePath);
  if (
    !sameFileSnapshot(opened.status, openedAfter) ||
    postRead.kind !== "file" ||
    !sameFileSnapshot(openedAfter, postRead.status) ||
    !realPathIsContained(root, resolveRealPath(postRead.absolutePath))
  ) {
    return repositoryRace();
  }
};

const createReadAccumulator = (
  mode: SafeRepositoryReadMode,
  byteSize: number,
): FileReadAccumulator | null => {
  const shouldRead = mode === "hash" ||
    (mode === "content" && byteSize <= MAX_TEXT_FILE_BYTES) ||
    (mode === "preview" && byteSize <= MAX_PREVIEW_FILE_BYTES);
  if (!shouldRead) return null;
  const content = mode === "content" || mode === "preview"
    ? Buffer.alloc(byteSize)
    : null;
  return {
    content,
    hash: createHash("sha256"),
    chunk: content ?? Buffer.alloc(Math.min(HASH_CHUNK_BYTES, Math.max(byteSize, 1))),
    byteSize,
    position: 0,
  };
};

const readNextChunk = (
  descriptor: number,
  accumulator: FileReadAccumulator,
  readFileChunk: ResolvedSafeFileReaderDependencies["readFileChunk"],
): boolean => {
  if (accumulator.position >= accumulator.byteSize) return false;
  const length = Math.min(
    HASH_CHUNK_BYTES,
    accumulator.byteSize - accumulator.position,
  );
  const count = readFileChunk(
    descriptor,
    accumulator.chunk,
    accumulator.content === null ? 0 : accumulator.position,
    length,
    accumulator.position,
  );
  if (count === 0) return repositoryRace();
  accumulator.hash.update(accumulator.content === null
    ? accumulator.chunk.subarray(0, count)
    : accumulator.chunk.subarray(accumulator.position, accumulator.position + count));
  accumulator.position += count;
  return accumulator.position < accumulator.byteSize;
};

const completedRead = (
  accumulator: FileReadAccumulator | null,
): Pick<Extract<SafeRepositoryFileRead, { readonly kind: "file" }>, "content" | "sha256"> => ({
  content: accumulator?.content ?? null,
  sha256: accumulator?.hash.digest("hex") ?? null,
});

const closeDescriptor = (descriptor: number | undefined): void => {
  if (descriptor === undefined) return;
  try {
    closeSync(descriptor);
  } catch {
    // A failed close cannot make unaccepted bytes safe to publish.
  }
};

const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolvePromise) => setImmediate(resolvePromise));

export const readSafeRepositoryFile = (
  root: string,
  relativePath: string,
  inspected: RepositoryPathInspection,
  mode: SafeRepositoryReadMode,
  dependencies: SafeFileReaderDependencies = {},
): SafeRepositoryFileRead => {
  if (inspected.kind !== "file") return { kind: "unsupported" };

  const resolved = resolveDependencies(dependencies);
  let descriptor: number | undefined;
  try {
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
    descriptor = resolved.openFileForRead(inspected.absolutePath, flags);
    const opened = validateOpenedRepositoryFile(
      root,
      relativePath,
      inspected,
      descriptor,
      resolved.resolveRealPath,
    );
    const accumulator = createReadAccumulator(mode, opened.byteSize);
    while (accumulator !== null && readNextChunk(
      descriptor,
      accumulator,
      resolved.readFileChunk,
    )) {
      // The synchronous import API intentionally completes without yielding.
    }
    validateRepositoryFileAfterRead(
      root,
      relativePath,
      descriptor,
      opened,
      resolved.resolveRealPath,
    );
    return { kind: "file", byteSize: opened.byteSize, ...completedRead(accumulator) };
  } catch (error) {
    if (error instanceof RepositoryImportError) throw error;
    return { kind: "unsupported" };
  } finally {
    closeDescriptor(descriptor);
  }
};

export const readSafeRepositoryFileAsync = async (
  root: string,
  relativePath: string,
  inspected: RepositoryPathInspection,
  mode: SafeRepositoryReadMode,
  signal: AbortSignal,
  dependencies: SafeFileReaderDependencies = {},
): Promise<SafeRepositoryFileRead> => {
  signal.throwIfAborted();
  if (inspected.kind !== "file") return { kind: "unsupported" };

  const resolved = resolveDependencies(dependencies);
  let descriptor: number | undefined;
  try {
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
    descriptor = resolved.openFileForRead(inspected.absolutePath, flags);
    const opened = validateOpenedRepositoryFile(
      root,
      relativePath,
      inspected,
      descriptor,
      resolved.resolveRealPath,
    );
    signal.throwIfAborted();
    const accumulator = createReadAccumulator(mode, opened.byteSize);
    while (accumulator !== null) {
      const hasMore = readNextChunk(descriptor, accumulator, resolved.readFileChunk);
      signal.throwIfAborted();
      if (!hasMore) break;
      await yieldToEventLoop();
      signal.throwIfAborted();
    }
    validateRepositoryFileAfterRead(
      root,
      relativePath,
      descriptor,
      opened,
      resolved.resolveRealPath,
    );
    signal.throwIfAborted();
    return { kind: "file", byteSize: opened.byteSize, ...completedRead(accumulator) };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof RepositoryImportError) throw error;
    return { kind: "unsupported" };
  } finally {
    closeDescriptor(descriptor);
  }
};
