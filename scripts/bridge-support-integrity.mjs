import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const linkError = () =>
  new Error("IntentArc bridge support payload cannot contain links.");
const entryError = () =>
  new Error("IntentArc bridge support payload contains an unsupported entry.");
const driftError = () =>
  new Error("IntentArc bridge support payload changed while being read.");

const sameFileState = (left, right) =>
  left.dev === right.dev && left.ino === right.ino &&
  left.size === right.size && left.mtimeMs === right.mtimeMs &&
  left.ctimeMs === right.ctimeMs && left.nlink === right.nlink;

const requireFinalPathState = async (path, expected, type) => {
  let final;
  try { final = await lstat(path); }
  catch { throw driftError(); }
  if (final.isSymbolicLink()) throw linkError();
  if (!final[type]() || !sameFileState(expected, final)) throw driftError();
  return final;
};

const readChunkBytes = 64 * 1024;

const updateFileDigest = async (hash, root, path, pathInfo) => {
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1) throw linkError();
    if (!sameFileState(pathInfo, before) ||
        !Number.isSafeInteger(before.size) || before.size < 0) {
      throw driftError();
    }

    hash.update(relative(root, path).replaceAll("\\", "/"));
    hash.update("\0");
    const chunk = Buffer.allocUnsafe(Math.min(readChunkBytes, before.size || 1));
    let position = 0;
    while (position < before.size) {
      const length = Math.min(chunk.length, before.size - position);
      const { bytesRead } = await handle.read(chunk, 0, length, position);
      if (bytesRead === 0) throw driftError();
      hash.update(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }

    const after = await handle.stat();
    if (!after.isFile() || after.nlink !== 1 ||
        !sameFileState(before, after)) throw driftError();
    await requireFinalPathState(path, after, "isFile");
    hash.update("\0");
  } finally { await handle.close(); }
};

const compareOrdinal = (left, right) =>
  left.name < right.name ? -1 : left.name > right.name ? 1 : 0;

export const directoryDigest = async (root) => {
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink()) throw linkError();
  if (!rootInfo.isDirectory()) throw entryError();
  const hash = createHash("sha256");
  const visit = async (current, expected) => {
    const directoryHandle = await open(
      current,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const before = await directoryHandle.stat();
      if (!before.isDirectory() || !sameFileState(expected, before)) {
        throw driftError();
      }
      const entries = (await readdir(current, { withFileTypes: true }))
        .sort(compareOrdinal);
      const afterRead = await directoryHandle.stat();
      if (!afterRead.isDirectory() || !sameFileState(before, afterRead)) {
        throw driftError();
      }
      await requireFinalPathState(current, afterRead, "isDirectory");

      for (const entry of entries) {
        const path = join(current, entry.name);
        const pathInfo = await lstat(path);
        if (pathInfo.isSymbolicLink()) throw linkError();
        if (pathInfo.isDirectory()) await visit(path, pathInfo);
        else if (pathInfo.isFile()) {
          await updateFileDigest(hash, root, path, pathInfo);
        } else throw entryError();
        await requireFinalPathState(
          path,
          pathInfo,
          pathInfo.isDirectory() ? "isDirectory" : "isFile",
        );
      }
      const after = await directoryHandle.stat();
      if (!after.isDirectory() || !sameFileState(before, after)) {
        throw driftError();
      }
      await requireFinalPathState(current, after, "isDirectory");
    } finally { await directoryHandle.close(); }
  };
  await visit(root, rootInfo);
  return hash.digest("hex");
};
