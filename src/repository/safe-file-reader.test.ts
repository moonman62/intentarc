import {
  appendFileSync,
  constants,
  mkdirSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  readSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_TEXT_FILE_BYTES } from "../import/filesystem-policy.js";
import {
  inspectRepositoryPath,
  MAX_PREVIEW_FILE_BYTES,
  readSafeRepositoryFile,
  readSafeRepositoryFileAsync,
} from "./safe-file-reader.js";

const temporaryDirectories: string[] = [];

const temporaryDirectory = (label: string): string => {
  const directory = mkdtempSync(join(tmpdir(), `intentarc safe reader ${label} `));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("safe repository file reader", () => {
  it("reports the first linked path segment without following a junction", () => {
    const root = temporaryDirectory("link-root");
    const outside = temporaryDirectory("link-outside");
    writeFileSync(join(outside, "canary.md"), "# OUTSIDE-CANARY\n");
    symlinkSync(outside, join(root, "docs"), "junction");

    expect(inspectRepositoryPath(root, "docs/canary.md")).toEqual({
      kind: "link",
      path: "docs",
    });
  });

  it("rejects a parent replaced after inspection without publishing outside bytes", () => {
    const root = temporaryDirectory("replacement-root");
    const outside = temporaryDirectory("replacement-outside");
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs", "evidence.md"), "# Original\n");
    writeFileSync(join(outside, "evidence.md"), "# OUTSIDE-CANARY\n");
    const inspected = inspectRepositoryPath(root, "docs/evidence.md");
    const originalParent = join(root, "docs");
    let replaced = false;

    const read = () => readSafeRepositoryFile(
      root,
      "docs/evidence.md",
      inspected,
      "content",
      {
        openFileForRead: (path, flags) => {
          if (!replaced) {
            replaced = true;
            renameSync(originalParent, join(root, "docs-before-race"));
            symlinkSync(outside, originalParent, "junction");
          }
          return openSync(path, flags || constants.O_RDONLY);
        },
      },
    );

    expect(read).toThrowError(expect.objectContaining({
      code: "unsupported_repository",
      details: { path: "repository" },
    }));
    expect(replaced).toBe(true);
    try {
      read();
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain("OUTSIDE-CANARY");
    }
  });

  it("rejects growth after the descriptor snapshot", () => {
    const root = temporaryDirectory("growth");
    const path = join(root, "README.md");
    writeFileSync(path, "# Stable\n");
    const inspected = inspectRepositoryPath(root, "README.md");
    let grew = false;

    expect(() => readSafeRepositoryFile(
      root,
      "README.md",
      inspected,
      "content",
      {
        readFileChunk: (descriptor, buffer, offset, length, position) => {
          if (!grew) {
            grew = true;
            appendFileSync(path, "changed after fstat\n");
          }
          return readSync(descriptor, buffer, offset, length, position);
        },
      },
    )).toThrowError(expect.objectContaining({ code: "unsupported_repository" }));
    expect(grew).toBe(true);
  });

  it("rejects a resolved descriptor target outside the canonical root", () => {
    const root = temporaryDirectory("realpath-root");
    const outside = temporaryDirectory("realpath-outside");
    writeFileSync(join(root, "README.md"), "# Stable\n");
    const outsidePath = join(outside, "README.md");
    writeFileSync(outsidePath, "# OUTSIDE-CANARY\n");
    const inspected = inspectRepositoryPath(root, "README.md");

    expect(() => readSafeRepositoryFile(
      root,
      "README.md",
      inspected,
      "content",
      { resolveRealPath: () => outsidePath },
    )).toThrowError(expect.objectContaining({ code: "unsupported_repository" }));
  });

  it("returns only size metadata when text exceeds its content budget", () => {
    const root = temporaryDirectory("oversized");
    writeFileSync(join(root, "large.txt"), Buffer.alloc(MAX_TEXT_FILE_BYTES + 1, 0x61));
    const inspected = inspectRepositoryPath(root, "large.txt");

    expect(readSafeRepositoryFile(
      root,
      "large.txt",
      inspected,
      "content",
    )).toEqual({
      kind: "file",
      byteSize: MAX_TEXT_FILE_BYTES + 1,
      content: null,
      sha256: null,
    });
  });

  it("returns bounded preview bytes with their descriptor-stable hash", () => {
    const root = temporaryDirectory("preview");
    writeFileSync(join(root, "diagram.png"), Buffer.from("preview-bytes"));
    const inspected = inspectRepositoryPath(root, "diagram.png");

    expect(readSafeRepositoryFile(
      root,
      "diagram.png",
      inspected,
      "preview",
    )).toEqual({
      kind: "file",
      byteSize: 13,
      content: Buffer.from("preview-bytes"),
      sha256: "50a7af5b18102fdfb3f706f256669bafca0770a2c7b9e26880523a5b6e9b4ea6",
    });
  });

  it("checks the preview ceiling before allocating or reading file bytes", () => {
    const root = temporaryDirectory("oversized-preview");
    writeFileSync(
      join(root, "oversized.pdf"),
      Buffer.alloc(MAX_PREVIEW_FILE_BYTES + 1, 0x25),
    );
    const inspected = inspectRepositoryPath(root, "oversized.pdf");
    let chunksRead = 0;

    expect(readSafeRepositoryFile(
      root,
      "oversized.pdf",
      inspected,
      "preview",
      {
        readFileChunk: (descriptor, buffer, offset, length, position) => {
          chunksRead += 1;
          return readSync(descriptor, buffer, offset, length, position);
        },
      },
    )).toEqual({
      kind: "file",
      byteSize: MAX_PREVIEW_FILE_BYTES + 1,
      content: null,
      sha256: null,
    });
    expect(chunksRead).toBe(0);
  });

  it("yields and aborts large hashing after a bounded number of fixed-size chunks", async () => {
    const root = temporaryDirectory("abort-hash");
    writeFileSync(join(root, "large.bin"), Buffer.alloc(4 * 1024 * 1024, 0x5a));
    const inspected = inspectRepositoryPath(root, "large.bin");
    const controller = new AbortController();
    let chunksRead = 0;
    setImmediate(() => controller.abort());

    await expect(readSafeRepositoryFileAsync(
      root,
      "large.bin",
      inspected,
      "hash",
      controller.signal,
      {
        readFileChunk: (descriptor, buffer, offset, length, position) => {
          chunksRead += 1;
          return readSync(descriptor, buffer, offset, length, position);
        },
      },
    )).rejects.toMatchObject({ name: "AbortError" });
    expect(chunksRead).toBeGreaterThan(0);
    expect(chunksRead).toBeLessThanOrEqual(2);
  });
});
