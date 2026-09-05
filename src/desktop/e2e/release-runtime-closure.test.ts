import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { createReadStream } from "node:fs";
import { lstat, mkdtemp, mkdir, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { classifyAbsoluteTarget, digestClosure } from "../../../scripts/release-runtime-closure.mjs";

const execFileAsync = promisify(execFile);
const helper = join(process.cwd(), "scripts", "release-runtime-closure.mjs");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "intentarc-runtime-closure-"));
  roots.push(root);
  const modules = join(root, "node_modules");
  await mkdir(join(modules, ".pnpm", "store"), { recursive: true });
  await mkdir(join(modules, ".bin"), { recursive: true });
  await mkdir(join(modules, "package", "nested"), { recursive: true });
  await writeFile(join(modules, "package", "nested", "value.txt"), "alpha", "utf8");
  await writeFile(join(modules, ".pnpm", "store", "lock.yaml"), "lock", "utf8");
  await writeFile(join(modules, ".bin", "tool.cmd"), "tool", "utf8");
  return { root, modules };
};

const run = (root: string, args = ["--repository-root", root, "--json"]) => execFileAsync(
  process.execPath,
  [helper, ...args],
  { encoding: "utf8", maxBuffer: 32 * 1024, timeout: 30_000 },
);

describe("release runtime closure", () => {
  it.each([
    ["win32", "C:\\runtime\\package", "native"],
    ["win32", "C:/runtime/package", "native"],
    ["win32", "/runtime/package", "foreign"],
    ["win32", "package", "relative"],
    ["posix", "/runtime/package", "native"],
    ["posix", "C:\\runtime\\package", "foreign"],
    ["posix", "C:/runtime/package", "foreign"],
    ["posix", "package", "relative"],
  ] as const)("classifies %s target %s as %s independent of the host", (platformFlavor, target, want) => {
    // Break caught: deriving both parsers' absolute result from process.platform
    // can reject native POSIX paths because win32.isAbsolute('/...') is also true.
    expect(classifyAbsoluteTarget(target, platformFlavor)).toBe(want);
  });

  it("hashes ordinal UTF-8 closure records deterministically without exposing paths", async () => {
    // Break caught: unordered traversal or a record format without file identity
    // can approve a changed dependency tree.
    const { root } = await fixture();
    const records = [
      "file\0.bin/tool.cmd\0" + "4\0" + sha256("tool") + "\n",
      "file\0.pnpm/store/lock.yaml\0" + "4\0" + sha256("lock") + "\n",
      "file\0package/nested/value.txt\0" + "5\0" + sha256("alpha") + "\n",
    ].sort();
    const want = {
      schema: "intentarc.release-runtime-closure/v1",
      sha256: sha256(records.join("")),
      fileCount: 3,
      totalBytes: 13,
    };

    const first = await run(root);
    const second = await run(root);

    expect(first.stderr).toBe("");
    expect(first.stdout).toBe(JSON.stringify(want));
    expect(second.stdout).toBe(first.stdout);
  });

  it("rejects closed arguments and an external link without reading its target", async () => {
    // Break caught: resolving a link before lexical containment lets an escape
    // observe protected or external state.
    const { root, modules } = await fixture();
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "secret.txt"), "secret", "utf8");
    await symlink("../../outside", join(modules, "escape"), "junction");

    await expect(run(root)).rejects.toMatchObject({ code: 1 });
    await expect(run(root, ["--repository-root", root])).rejects.toMatchObject({ code: 1 });
    await expect(run(root, ["--repository-root", "relative", "--json"])).rejects.toMatchObject({ code: 1 });
  });

  it("records an equivalent contained target identically for native-absolute and relative link text", async () => {
    // Break caught: blanket absolute-target rejection refuses Windows pnpm
    // directory junctions even when their lexical and canonical target remains
    // beneath the same node_modules tree.
    const { root, modules } = await fixture();
    const link = resolve(modules, "runtime-link");
    const target = resolve(modules, "package");
    const closureFor = (linkText: string) => digestClosure(root, {
      readdir: async (path: string) => resolve(path) === resolve(modules) ? [{ name: "runtime-link" }] : [],
      lstat: async (path: string) => resolve(path) === link
        ? { isFile: () => false, isDirectory: () => false, isSymbolicLink: () => true }
        : lstat(path),
      readlink: async (path: string) => resolve(path) === link ? linkText : readlink(path),
    } as Parameters<typeof digestClosure>[1]);

    const relativeClosure = await closureFor("package");
    const absoluteClosure = await closureFor(target);
    const want = {
      schema: "intentarc.release-runtime-closure/v1",
      sha256: sha256("link\0runtime-link\0node_modules/package\n"),
      fileCount: 0,
      totalBytes: 0,
    };

    expect(relativeClosure).toEqual(want);
    expect(absoluteClosure).toEqual(want);
  });

  it.runIf(process.platform === "win32")(
    "hashes a real contained Windows directory junction deterministically",
    async () => {
      // Break caught: an injected absolute-link test alone could miss the
      // actual link text returned by Node for a Windows directory junction.
      const { root, modules } = await fixture();
      const junction = join(modules, "runtime-link");
      await symlink(join(modules, "package"), junction, "junction");

      const first = await digestClosure(root);
      const second = await digestClosure(root);

      expect(first).toEqual(second);
      expect(first).toMatchObject({
        schema: "intentarc.release-runtime-closure/v1",
        fileCount: 3,
        totalBytes: 13,
      });
    },
  );

  it.runIf(process.platform === "win32")(
    "rejects POSIX absolute link syntax before observing its contained-looking target",
    async () => {
      // Break caught: Windows path.isAbsolute also classifies a POSIX-rooted
      // spelling as absolute, so lexical containment alone could accept
      // foreign syntax when it happens to map onto the current drive.
      const { root, modules } = await fixture();
      const link = resolve(modules, "foreign-absolute-link");
      const target = resolve(modules, "package");
      const posixAbsoluteTarget = target.replace(/^[A-Za-z]:/, "").replaceAll("\\", "/");
      const observed: string[] = [];
      const trapTarget = (path: string, operation: string) => {
        if (resolve(path) === target) {
          observed.push(operation);
          throw new Error("foreign-target-observed");
        }
      };

      await expect(digestClosure(root, {
        readdir: async (path: string) => {
          trapTarget(path, "readdir");
          return resolve(path) === resolve(modules) ? [{ name: "foreign-absolute-link" }] : [];
        },
        lstat: async (path: string) => {
          trapTarget(path, "lstat");
          return resolve(path) === link
            ? { isFile: () => false, isDirectory: () => false, isSymbolicLink: () => true }
            : lstat(path);
        },
        readlink: async (path: string) => resolve(path) === link ? posixAbsoluteTarget : readlink(path),
        realpath: async (path: string) => { trapTarget(path, "realpath"); return resolve(path); },
        createReadStream: (path: string) => {
          trapTarget(path, "open/read");
          return createReadStream(path);
        },
      } as Parameters<typeof digestClosure>[1])).rejects.toThrow("runtime-closure-invalid");

      expect(observed).toEqual([]);
    },
  );

  it("rejects a contained link whose resolved target is not an ordinary file or directory", async () => {
    // Break caught: accepting a contained link without classifying its resolved
    // target authorizes a FIFO, socket, device, or other nonordinary runtime node.
    // Windows cannot safely create those node types in this workspace, so this
    // injects only the resolved-target stat result while the real traversal,
    // lexical link checks, resolution, and rejection decision remain exercised.
    const { root, modules } = await fixture();
    const link = resolve(modules, ".bin", "tool.cmd");
    const target = resolve(modules, "package", "nested", "value.txt");

    await expect(digestClosure(root, {
      lstat: async (path: string) => {
        if (resolve(path) === link) {
          return { isFile: () => false, isDirectory: () => false, isSymbolicLink: () => true };
        }
        if (resolve(path) !== target) return lstat(path);
        return { isFile: () => false, isDirectory: () => false, isSymbolicLink: () => false };
      },
      readlink: async (path: string) => resolve(path) === link ? "../package/nested/value.txt" : readlink(path),
    })).rejects.toThrow("runtime-closure-invalid");
  });

  it("rejects accidental directory identity drift across runtime enumeration", async () => {
    // Break caught: classifying a runtime directory only before readdir can
    // record children from a replacement directory on a controlled host.
    const { root, modules } = await fixture();
    let moduleStats = 0;

    await expect(digestClosure(root, {
      lstat: async (path: string) => {
        const value = await lstat(path);
        if (resolve(path) !== resolve(modules)) return value;
        moduleStats++;
        return {
          dev: 101,
          ino: moduleStats,
          size: 0,
          mtimeMs: 0,
          ctimeMs: 0,
          isDirectory: () => true,
          isFile: () => false,
          isSymbolicLink: () => false,
        };
      },
    })).rejects.toThrow("runtime-closure-invalid");
  });

  it.each([".intentarc.sqlite.backups", ".playwright-cli", "output"])(
    "rejects a protected escape name %s before target observation",
    async (protectedLeaf) => {
      // Break caught: resolving an escaped runtime link before lexical
      // containment could observe an excluded target. The listing is injected
      // so no protected path is ever created or inspected by this test.
      const { root, modules } = await fixture();
      const escape = resolve(modules, "escape");
      const protectedTarget = resolve(modules, "..", protectedLeaf);
      const observed: string[] = [];
      let controlledFileOpens = 0;
      const trap = (path: string, operation: string) => {
        if (resolve(path) === protectedTarget) {
          observed.push(operation);
          throw new Error("protected-target-observed");
        }
      };

      const filesystem = {
        readdir: async (path: string) => {
          trap(path, "readdir");
          const entries = await readdir(path, { withFileTypes: true });
          return resolve(path) === resolve(modules) ? [...entries, { name: "escape" }] : entries;
        },
        lstat: async (path: string) => { trap(path, "lstat"); return resolve(path) === escape
          ? { isFile: () => false, isDirectory: () => false, isSymbolicLink: () => true }
          : lstat(path); },
        readlink: async (path: string) => { trap(path, "readlink"); return resolve(path) === escape ? `../${protectedLeaf}` : readlink(path); },
        realpath: async (path: string) => { trap(path, "realpath"); return resolve(path); },
        createReadStream: (path: string) => {
          trap(path, "open/read");
          controlledFileOpens++;
          return createReadStream(path);
        },
      } as Parameters<typeof digestClosure>[1] & { readdir: (path: string) => Promise<Array<{ name: string }>> };
      await expect(digestClosure(root, filesystem)).rejects.toThrow("runtime-closure-invalid");
      expect(controlledFileOpens).toBeGreaterThan(0);
      expect(observed).toEqual([]);
    },
  );

  it.each([".intentarc.sqlite.backups", ".playwright-cli", "output"])(
    "rejects an absolute protected sibling target %s before target observation",
    async (protectedLeaf) => {
      // Break caught: accepting native absolute junction text before lexical
      // containment could observe an excluded sibling target. The target is
      // represented only as an injected string and is never created or read.
      const { root, modules } = await fixture();
      const escape = resolve(modules, "absolute-escape");
      const protectedTarget = resolve(modules, "..", protectedLeaf);
      const observed: string[] = [];
      let controlledFileOpens = 0;
      const trap = (path: string, operation: string) => {
        if (resolve(path) === protectedTarget) {
          observed.push(operation);
          throw new Error("protected-target-observed");
        }
      };

      const filesystem = {
        readdir: async (path: string) => {
          trap(path, "readdir");
          const entries = await readdir(path, { withFileTypes: true });
          return resolve(path) === resolve(modules) ? [...entries, { name: "absolute-escape" }] : entries;
        },
        lstat: async (path: string) => {
          trap(path, "lstat");
          return resolve(path) === escape
            ? { isFile: () => false, isDirectory: () => false, isSymbolicLink: () => true }
            : lstat(path);
        },
        readlink: async (path: string) => {
          trap(path, "readlink");
          return resolve(path) === escape ? protectedTarget : readlink(path);
        },
        realpath: async (path: string) => { trap(path, "realpath"); return resolve(path); },
        createReadStream: (path: string) => {
          trap(path, "open/read");
          controlledFileOpens++;
          return createReadStream(path);
        },
      } as Parameters<typeof digestClosure>[1] & { readdir: (path: string) => Promise<Array<{ name: string }>> };

      await expect(digestClosure(root, filesystem)).rejects.toThrow("runtime-closure-invalid");
      expect(controlledFileOpens).toBeGreaterThan(0);
      expect(observed).toEqual([]);
    },
  );

  it("rejects a lexical contained target whose canonical result escapes before observing the result", async () => {
    // Break caught: lexical containment without a second canonical-containment
    // gate could classify, open, or traverse the escaped realpath result.
    const { root, modules } = await fixture();
    const link = resolve(modules, "canonical-escape");
    const candidate = resolve(modules, "virtual-contained-target");
    const escaped = resolve(modules, "..", "escaped-target");
    const escapedOperations: string[] = [];
    let candidateRealpathCalls = 0;
    const trapEscaped = (path: string, operation: string) => {
      if (resolve(path) === escaped) {
        escapedOperations.push(operation);
        throw new Error("canonical-escape-observed");
      }
    };

    await expect(digestClosure(root, {
      readdir: async (path: string) => {
        trapEscaped(path, "readdir");
        return resolve(path) === resolve(modules) ? [{ name: "canonical-escape" }] : [];
      },
      lstat: async (path: string) => {
        trapEscaped(path, "lstat");
        return resolve(path) === link
          ? { isFile: () => false, isDirectory: () => false, isSymbolicLink: () => true }
          : lstat(path);
      },
      readlink: async (path: string) => resolve(path) === link ? "virtual-contained-target" : readlink(path),
      realpath: async (path: string) => {
        if (resolve(path) === candidate) {
          candidateRealpathCalls++;
          return escaped;
        }
        trapEscaped(path, "realpath");
        return resolve(path);
      },
      createReadStream: (path: string) => {
        trapEscaped(path, "open/read");
        return createReadStream(path);
      },
    } as Parameters<typeof digestClosure>[1])).rejects.toThrow("runtime-closure-invalid");

    expect(candidateRealpathCalls).toBe(1);
    expect(escapedOperations).toEqual([]);
  });

  it("rejects configured runtime entry and byte bounds before producing a closure", async () => {
    // Break caught: an unbounded traversal or stream could consume arbitrary
    // controlled-host runtime input before the controller marker boundary.
    const { root } = await fixture();

    await expect(digestClosure(root, { maximumEntries: 0 } as Parameters<typeof digestClosure>[1]))
      .rejects.toThrow("runtime-closure-invalid");
    await expect(digestClosure(root, { maximumBytes: 1 } as Parameters<typeof digestClosure>[1]))
      .rejects.toThrow("runtime-closure-invalid");
  });

  it("destroys an overproducing file stream at the first expected-size excess", async () => {
    // Break caught: checking the stat size only after two complete reads lets a
    // growing or dishonest stream consume unbounded input before failing.
    const { root, modules } = await fixture();
    const target = resolve(modules, ".bin", "tool.cmd");
    let emittedBytes = 0;
    let destroyCalls = 0;

    await expect(digestClosure(root, {
      maximumBytes: 4,
      createReadStream: (path: string) => {
        if (resolve(path) !== target) return createReadStream(path);
        const stream = new EventEmitter() as EventEmitter & {
          destroy(error: Error): void;
        };
        let destroyed = false;
        stream.destroy = (error: Error) => {
          destroyCalls++;
          destroyed = true;
          queueMicrotask(() => stream.emit("error", error));
        };
        queueMicrotask(() => {
          for (const chunk of [Buffer.alloc(5), Buffer.alloc(1024)]) {
            if (destroyed) break;
            emittedBytes += chunk.length;
            stream.emit("data", chunk);
          }
          if (!destroyed) stream.emit("end");
        });
        return stream as unknown as ReturnType<typeof createReadStream>;
      },
    })).rejects.toThrow("runtime-closure-invalid");
    expect(emittedBytes).toBe(5);
    expect(destroyCalls).toBe(1);
  });

  it("rejects duplicate normalized runtime entry paths before producing a closure", async () => {
    // Break caught: accepting the same normalized entry twice makes the digest
    // depend on an ambiguous runtime listing rather than one closed tree.
    const { root, modules } = await fixture();
    await expect(digestClosure(root, {
      readdir: async (path: string) => resolve(path) === resolve(modules)
        ? [{ name: "package" }, { name: "package" }]
        : [],
    } as Parameters<typeof digestClosure>[1])).rejects.toThrow("runtime-closure-invalid");
  });

  it("changes the closure when a contained link text changes", async () => {
    // Break caught: omitting the normalized link target from closure records
    // makes a changed runtime link indistinguishable from the reviewed tree.
    const { root, modules } = await fixture();
    const link = resolve(modules, "runtime-link");
    const closureFor = async (target: string) => digestClosure(root, {
      readdir: async (path: string) => resolve(path) === resolve(modules) ? [{ name: "runtime-link" }] : [],
      lstat: async (path: string) => resolve(path) === link
        ? { isFile: () => false, isDirectory: () => false, isSymbolicLink: () => true }
        : lstat(path),
      readlink: async (path: string) => resolve(path) === link ? target : readlink(path),
    } as Parameters<typeof digestClosure>[1]);

    const first = await closureFor("package");
    const second = await closureFor(".pnpm/store");

    expect(second.sha256).not.toBe(first.sha256);
  });

  it("uses the narrow realpath boundary only after a link is lexically contained", async () => {
    // Break caught: a hard-wired resolution call prevents the protected-target
    // trap from proving that the helper never resolves an escaped link.
    const { root, modules } = await fixture();
    const link = resolve(modules, "runtime-link");
    const containedTarget = resolve(modules, "package");
    const closure = await digestClosure(root, {
      readdir: async (path: string) => resolve(path) === resolve(modules) ? [{ name: "runtime-link" }] : [],
      lstat: async (path: string) => resolve(path) === link
        ? { isFile: () => false, isDirectory: () => false, isSymbolicLink: () => true }
        : lstat(path),
      readlink: async (path: string) => resolve(path) === link ? "virtual-contained-target" : readlink(path),
      realpath: async (path: string) => resolve(path) === resolve(modules, "virtual-contained-target")
        ? containedTarget
        : resolve(path),
    } as Parameters<typeof digestClosure>[1]);

    expect(closure).toMatchObject({ schema: "intentarc.release-runtime-closure/v1", fileCount: 0, totalBytes: 0 });
  });

  it("is dormant when imported as a module", async () => {
    // Break caught: import-time traversal would observe runtime input before
    // the controller deliberately invokes the closed helper interface.
    const imported = await execFileAsync(
      process.execPath,
      ["--input-type=module", "--eval", `await import(${JSON.stringify(pathToFileURL(helper).href)}); process.stdout.write("dormant")`],
      { encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 },
    );

    expect(imported).toMatchObject({ stdout: "dormant", stderr: "" });
  });
});
