import { createHash, randomUUID, X509Certificate } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { execFile, spawn as spawnChild } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, expect, test, vi } from "vitest";
import { openSignedArtifactSession } from "../../../scripts/signed-artifact-bundle-coordinator.mjs";
import {
  parseSignedArtifactArguments,
  validatePublisherBytes,
  validateSignedArtifactManifest,
  validateSignedArtifactResult,
} from "../../../scripts/signed-artifact-bundle.mjs";

const manifestError = "IntentArc signed artifact manifest is invalid.";
const publisherError = "IntentArc signed artifact publisher is invalid.";
const resultError = "IntentArc signed artifact result is invalid.";
const coordinatorError = "IntentArc signed artifact coordinator failed.";
const compositionMockSpecifiers = [
  "../../../scripts/signed-artifact-bundle-coordinator.mjs",
  "../../../scripts/desktop-release.mjs",
  "../../../scripts/bridge-native-release.mjs",
  "../../../scripts/bridge-diagnostic-audit.mjs",
  "node:fs/promises",
  "node:crypto",
] as const;
const initialAuditRoot = process.env.INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_ROOT;
const initialAuditPath = process.env.INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_PATH;

const mutantRoots = new Set<string>();
const sameByteMutationKey = Symbol.for("intentarc.test.mutated-publisher-bytes");
type VerifierMutation = { name: string; before: string; after: string };
const trackedVerifierPaths = [
  join(process.cwd(), "scripts", "signed-artifact-bundle.mjs"),
  join(process.cwd(), "scripts", "signed-artifact-bundle-coordinator.mjs"),
];

const rewriteRelativeTrackedImports = (source: string, sourcePath: string) => source.replace(
  /(from\s+)(["'])(\.\.?\/[^"']+)\2/g,
  (_match, prefix: string, quote: string, specifier: string) =>
    `${prefix}${quote}${new URL(specifier, pathToFileURL(sourcePath)).href}${quote}`,
);

const createMutatedVerifier = async ({ name, before, after }: VerifierMutation) => {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || before.length === 0 || before === after) {
    throw new Error(`Invalid verifier mutant: ${name}.`);
  }
  const candidates = await Promise.all(trackedVerifierPaths.map(async (sourcePath) => ({
    sourcePath,
    source: (await readFile(sourcePath, "utf8")).replaceAll("\r\n", "\n"),
  })));
  const occurrences = candidates.flatMap(({ sourcePath, source }) => {
    const matches = source.split(before).length - 1;
    return Array.from({ length: matches }, () => sourcePath);
  });
  if (occurrences.length !== 1) {
    throw new Error(`Verifier mutant ${name} requires exactly one source occurrence; found ${occurrences.length}.`);
  }

  const sourcePath = occurrences[0];
  const source = candidates.find((candidate) => candidate.sourcePath === sourcePath)!.source;
  const canonicalTemporaryRoot = await realpath(tmpdir());
  const root = join(canonicalTemporaryRoot, `intentarc-mutated-verifier-${randomUUID()}`);
  await mkdir(root);
  mutantRoots.add(root);
  const mutantPath = join(root, `${name}.mjs`);
  const mutantSource = rewriteRelativeTrackedImports(source.replace(before, after), sourcePath);
  await writeFile(mutantPath, mutantSource);
  const module = await import(/* @vite-ignore */ `${pathToFileURL(mutantPath).href}?mutant=${encodeURIComponent(name)}-${randomUUID()}`);
  return { module, mutantPath };
};

const importMutatedVerifier = async (mutation: VerifierMutation) =>
  (await createMutatedVerifier(mutation)).module;

const expectMutantKilledAt = async (name: string, assertion: string, exercise: () => Promise<void>) => {
  await expect(exercise()).rejects.toThrow(`[mutant:${name}] ${assertion}`);
};

const expectRejectedAt = async (promise: Promise<unknown>, marker: string, message: string) => {
  let thrown: unknown;
  try { await promise; } catch (error) { thrown = error; }
  expect(thrown, marker).toBeInstanceOf(Error);
  expect((thrown as Error).message, marker).toBe(message);
};

afterEach(async () => {
  for (const specifier of compositionMockSpecifiers) vi.doUnmock(specifier);
  await vi.importActual("node:path");
  vi.resetModules();
  if (initialAuditRoot === undefined) delete process.env.INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_ROOT;
  else process.env.INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_ROOT = initialAuditRoot;
  if (initialAuditPath === undefined) delete process.env.INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_PATH;
  else process.env.INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_PATH = initialAuditPath;
  delete (globalThis as Record<PropertyKey, unknown>)[sameByteMutationKey];
  const roots = [...mutantRoots];
  mutantRoots.clear();
  for (const root of roots) {
    await rm(root, { recursive: true, force: true });
    await expect(lstat(root), `temporary mutant root residue: ${root}`).rejects.toMatchObject({ code: "ENOENT" });
  }
});

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

const runMeasuredManifestCli = async (scriptPath: string, documentPath: string) => {
  if (scriptPath.includes('"') || documentPath.includes('"')) throw new Error("Unsupported measured CLI path.");
  const encoded = (value: string) => Buffer.from(value, "utf16le").toString("base64");
  const powershellSource = String.raw`
$node = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded(process.execPath)}'))
$script = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded(scriptPath)}'))
$document = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded(documentPath)}'))
$info = [Diagnostics.ProcessStartInfo]::new()
$info.FileName = $node
$info.Arguments = '"' + $script + '" validate-manifest --document "' + $document + '"'
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$info.RedirectStandardOutput = $true
$info.RedirectStandardError = $true
$info.EnvironmentVariables.Clear()
$info.EnvironmentVariables['SystemRoot'] = $env:SystemRoot
$info.EnvironmentVariables['WINDIR'] = $env:WINDIR
$process = [Diagnostics.Process]::Start($info)
$stdout = $process.StandardOutput.ReadToEndAsync()
$stderr = $process.StandardError.ReadToEndAsync()
$peakWorkingSetBytes = 0L
while ($true) {
  try {
    $process.Refresh()
    if ($process.WorkingSet64 -gt $peakWorkingSetBytes) { $peakWorkingSetBytes = $process.WorkingSet64 }
  } catch {}
  if ($process.WaitForExit(1)) { break }
}
[ordered]@{
  exitCode = $process.ExitCode
  peakWorkingSetBytes = $peakWorkingSetBytes
  stderr = $stderr.Result
  stdout = $stdout.Result
} | ConvertTo-Json -Compress
`;
  const powershell = join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const { stdout } = await promisify(execFile)(powershell, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(powershellSource, "utf16le").toString("base64"),
  ], {
    env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR },
    windowsHide: true,
  });
  return JSON.parse(stdout) as {
    exitCode: number;
    peakWorkingSetBytes: number;
    stderr: string;
    stdout: string;
  };
};

const runNodeCapture = async (argumentsList: string[]) => {
  const child = spawnChild(process.execPath, argumentsList, {
    env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const exitCode = await new Promise<number | null>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", resolveExit);
  });
  return { exitCode, stderr, stdout };
};

const makeCoordinatorFixture = async (rows = [{ path: "payload/artifact.bin", contents: Buffer.from("artifact") }]) => {
  const root = await mkdtemp(join(tmpdir(), "intentarc-signed-artifact-"));
  const publisherBytes = Buffer.from("bounded publisher evidence");
  const files = [];
  for (const row of rows) {
    const path = join(root, ...row.path.split("/"));
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, row.contents);
    files.push({ path: row.path, bytes: row.contents.length, sha256: sha256(row.contents) });
  }
  const manifest = { files, publisher: { cerSha256: sha256(publisherBytes) } };
  await writeFile(join(root, "publisher.cer"), publisherBytes);
  await writeFile(join(root, "bundle.json"), Buffer.from(JSON.stringify(manifest)));
  return { files, manifest, publisherBytes, root };
};

test.runIf(process.platform === "win32")("opens a bounded signed-artifact session with one persistent coordinator", async () => {
  const root = await mkdtemp(join(tmpdir(), "intentarc-signed-artifact-"));
  await mkdir(join(root, "payload"));
  await writeFile(join(root, "bundle.json"), Buffer.from("{}"));
  await writeFile(join(root, "publisher.cer"), Buffer.from("publisher"));
  await writeFile(join(root, "payload", "artifact.bin"), Buffer.from("artifact"));
  const session = await openSignedArtifactSession({ bundleRoot: root });
  try {
    expect(await session.readManifest()).toEqual(Buffer.from("{}"));
  } finally {
    await session.close();
    await rm(root, { recursive: true, force: true });
  }
});

test.runIf(process.platform === "win32")("spawns exactly one resolved hidden PowerShell child with fixed arguments and two-key environment", async () => {
  const spawn = vi.fn((_command: string, _arguments: string[], _options: object) => {
    const child = new EventEmitter() as any;
    child.stdout = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = vi.fn(() => true);
    let buffered = "";
    child.stdin = new Writable({
      write(chunk, _encoding, callback) {
        buffered += chunk.toString("utf8");
        while (buffered.includes("\n")) {
          const newline = buffered.indexOf("\n");
          const request = JSON.parse(buffered.slice(0, newline));
          buffered = buffered.slice(newline + 1);
          child.stdout.write(`${JSON.stringify({
            category: "",
            id: request.id,
            manifestBytes: request.command === "readManifest" ? Buffer.from("{}").toString("base64") : "",
            ok: true,
            publisherBytes: "",
            rows: [],
          })}\n`);
          if (request.command === "close") setImmediate(() => {
            child.exitCode = 0;
            child.emit("exit", 0, null);
            child.emit("close", 0, null);
          });
        }
        callback();
      },
    });
    return child;
  });
  vi.doMock("node:child_process", async (importOriginal) => ({ ...(await importOriginal()), spawn }));
  vi.doMock("../../../src/system/windows-powershell.js", () => ({
    resolveWindowsPowerShellInvocation: () => ({
      executablePath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      environment: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows", SHOULD_NOT_LEAK: "secret" },
    }),
  }));
  try {
    const module = await import("../../../scripts/signed-artifact-bundle-coordinator.mjs?spawn-contract");
    const session = await module.openSignedArtifactSession({ bundleRoot: "C:\\bounded-fixture" });
    await session.readManifest();
    await session.close();
    expect(spawn).toHaveBeenCalledOnce();
    const [command, arguments_, options] = spawn.mock.calls[0];
    expect(command).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(arguments_.slice(0, 4)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
    expect(arguments_).toHaveLength(5);
    expect(arguments_[4]).toContain("IntentArcBundleNative");
    expect(options).toMatchObject({
      env: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows" },
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    expect(Object.keys((options as any).env).sort()).toEqual(["SystemRoot", "WINDIR"]);
  } finally {
    vi.doUnmock("node:child_process");
    vi.doUnmock("../../../src/system/windows-powershell.js");
  }
});

test("binds the main verifier to the coordinator's closed transport schema", async () => {
  const manifest = validManifest();
  const rows = manifest.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }));
  const settle = vi.fn(async () => undefined);
  const close = vi.fn(async () => undefined);
  vi.doMock("../../../scripts/signed-artifact-bundle-coordinator.mjs", () => ({
    openSignedArtifactSession: vi.fn(async () => ({
      readManifest: async () => Buffer.from(JSON.stringify(manifest)),
      openExpected: async () => ({ publisherBytes: publicDer, rows }),
      evidence: rows,
      settle,
      close,
    })),
  }));
  const module = await import("../../../scripts/signed-artifact-bundle.mjs?coordinator-transport");
  const transport = await module.openSignedArtifactBundle({ bundleRoot: "C:\\bounded-fixture" });
  expect(Object.keys(transport).sort()).toEqual(["close", "manifestBytes", "publisherBytes", "rows", "settle"]);
  expect(transport.rows).toEqual(rows);
  await transport.settle();
  await transport.close();
  expect(settle).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
  vi.doUnmock("../../../scripts/signed-artifact-bundle-coordinator.mjs");
});

test("preserves a primary and close failure as one fixed aggregate category", async () => {
  vi.doMock("../../../scripts/signed-artifact-bundle-coordinator.mjs", () => ({
    openSignedArtifactSession: vi.fn(async () => ({
      readManifest: async () => { throw new Error("primary detail"); },
      openExpected: async () => { throw new Error("unused"); },
      evidence: [],
      settle: async () => undefined,
      close: async () => { throw new Error("close detail"); },
    })),
  }));
  const module = await import("../../../scripts/signed-artifact-bundle.mjs?coordinator-aggregate");
  await expect(module.openSignedArtifactBundle({ bundleRoot: "C:\\bounded-fixture" }))
    .rejects.toThrow("IntentArc signed artifact session and cleanup failed.");
  vi.doUnmock("../../../scripts/signed-artifact-bundle-coordinator.mjs");
});

test.runIf(process.platform === "win32")("rejects a manifest over 2 MiB before returning bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "intentarc-signed-artifact-"));
  await writeFile(join(root, "bundle.json"), Buffer.alloc(2 * 1024 * 1024 + 1));
  const session = await openSignedArtifactSession({ bundleRoot: root });
  try { await expect(session.readManifest()).rejects.toThrow(coordinatorError); }
  finally { await session.close(); await rm(root, { recursive: true, force: true }); }
});

test.runIf(process.platform === "win32")("rejects an expected length mismatch before accepting row evidence", async () => {
  const fixture = await makeCoordinatorFixture();
  fixture.manifest.files[0].bytes += 1;
  const session = await openSignedArtifactSession({ bundleRoot: fixture.root });
  try {
    await session.readManifest();
    await expect(session.openExpected(fixture.manifest)).rejects.toThrow(coordinatorError);
    expect(session.evidence).toEqual([]);
  } finally { await session.close(); await rm(fixture.root, { recursive: true, force: true }); }
});

test.runIf(process.platform === "win32")("rejects the aggregate budget before opening impossible rows", async () => {
  const fixture = await makeCoordinatorFixture([
    { path: "payload/a.bin", contents: Buffer.from("a") },
    { path: "payload/b.bin", contents: Buffer.from("b") },
  ]);
  fixture.manifest.files[0].bytes = 4 * 1024 * 1024 * 1024;
  fixture.manifest.files[1].bytes = 1;
  const session = await openSignedArtifactSession({ bundleRoot: fixture.root });
  try {
    await session.readManifest();
    await expect(session.openExpected(fixture.manifest)).rejects.toThrow(coordinatorError);
  } finally { await session.close(); await rm(fixture.root, { recursive: true, force: true }); }
});

test.runIf(process.platform === "win32")("returns publisher bytes and bounded row evidence without artifact bytes", async () => {
  const fixture = await makeCoordinatorFixture();
  const session = await openSignedArtifactSession({ bundleRoot: fixture.root });
  try {
    await session.readManifest();
    const opened = await session.openExpected(fixture.manifest);
    expect(opened.publisherBytes).toEqual(fixture.publisherBytes);
    expect(opened.rows).toEqual(fixture.files);
    expect(Object.keys(opened.rows[0]).sort()).toEqual(["bytes", "path", "sha256"]);
    expect(session.evidence).toEqual(fixture.files);
    await session.settle();
  } finally { await session.close(); await rm(fixture.root, { recursive: true, force: true }); }
});

test.runIf(process.platform === "win32")("rejects a physical entry created after the initial topology snapshot", async () => {
  const fixture = await makeCoordinatorFixture();
  const session = await openSignedArtifactSession({ bundleRoot: fixture.root });
  try {
    await session.readManifest();
    await session.openExpected(fixture.manifest);
    await writeFile(join(fixture.root, "payload", "late-extra.bin"), "extra");
    await expect(session.settle()).rejects.toThrow(coordinatorError);
  } finally { await session.close(); await rm(fixture.root, { recursive: true, force: true }); }
});

test.runIf(process.platform === "win32")("retains file handles until close and releases exclusive mutation afterward", async () => {
  const fixture = await makeCoordinatorFixture();
  const artifact = join(fixture.root, "payload", "artifact.bin");
  const session = await openSignedArtifactSession({ bundleRoot: fixture.root });
  await session.readManifest();
  await session.openExpected(fixture.manifest);
  await expect(open(artifact, "r+")).rejects.toBeDefined();
  await expect(truncate(artifact, 1)).rejects.toBeDefined();
  await expect(rename(artifact, `${artifact}.renamed`)).rejects.toBeDefined();
  await expect(rm(artifact)).rejects.toBeDefined();
  await session.close();
  await writeFile(artifact, "replacement");
  await truncate(artifact, 4);
  const renamed = `${artifact}.renamed`;
  await rename(artifact, renamed);
  await rm(renamed);
  await rm(fixture.root, { recursive: true, force: true });
});

test.runIf(process.platform === "win32")("memoizes concurrent close and rejects commands as soon as closing begins", async () => {
  const fixture = await makeCoordinatorFixture();
  const session = await openSignedArtifactSession({ bundleRoot: fixture.root });
  await session.readManifest();
  await session.openExpected(fixture.manifest);
  let firstCloseSettled = false;
  const first = session.close().finally(() => { firstCloseSettled = true; });
  const second = session.close();
  await expect(session.settle()).rejects.toThrow(coordinatorError);
  expect(firstCloseSettled).toBe(false);
  await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
  await rm(fixture.root, { recursive: true, force: true });
});

test.runIf(process.platform === "win32")("rejects hard-linked expected files", async () => {
  const fixture = await makeCoordinatorFixture();
  const outside = await mkdtemp(join(tmpdir(), "intentarc-signed-artifact-hardlink-"));
  await link(join(fixture.root, "payload", "artifact.bin"), join(outside, "artifact-link.bin"));
  const session = await openSignedArtifactSession({ bundleRoot: fixture.root });
  try { await session.readManifest(); await expect(session.openExpected(fixture.manifest)).rejects.toThrow(coordinatorError); }
  finally {
    await session.close();
    await rm(fixture.root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test.runIf(process.platform === "win32")("rejects a reparse ancestor", async () => {
  const target = await makeCoordinatorFixture();
  const parent = await mkdtemp(join(tmpdir(), "intentarc-signed-artifact-link-"));
  const linkedRoot = join(parent, "bundle");
  await symlink(target.root, linkedRoot, "junction");
  await expect(openSignedArtifactSession({ bundleRoot: linkedRoot }).then((session) =>
    session.readManifest().finally(() => session.close()))).rejects.toThrow(coordinatorError);
  await rm(parent, { recursive: true, force: true });
  await rm(target.root, { recursive: true, force: true });
});

test.runIf(process.platform === "win32").each(["unlisted root file", "unlisted nested file", "unlisted directory"])
  ("rejects physical closure violation: %s", async (kind) => {
    const fixture = await makeCoordinatorFixture();
    if (kind === "unlisted root file") await writeFile(join(fixture.root, "extra.bin"), "extra");
    if (kind === "unlisted nested file") await writeFile(join(fixture.root, "payload", "extra.bin"), "extra");
    if (kind === "unlisted directory") await mkdir(join(fixture.root, "unlisted"));
    const session = await openSignedArtifactSession({ bundleRoot: fixture.root });
    try { await session.readManifest(); await expect(session.openExpected(fixture.manifest)).rejects.toThrow(coordinatorError); }
    finally { await session.close(); await rm(fixture.root, { recursive: true, force: true }); }
  });

test.runIf(process.platform === "win32")("rejects excessive expected depth and directory count", async () => {
  const deep = await makeCoordinatorFixture([{ path: `${Array.from({ length: 17 }, (_, i) => `d${i}`).join("/")}/a.bin`, contents: Buffer.from("a") }]);
  let session = await openSignedArtifactSession({ bundleRoot: deep.root });
  try { await session.readManifest(); await expect(session.openExpected(deep.manifest)).rejects.toThrow(coordinatorError); }
  finally { await session.close(); await rm(deep.root, { recursive: true, force: true }); }

  const rows = Array.from({ length: 8 }, (_, row) => ({
    path: `${Array.from({ length: 16 }, (_, depth) => `r${row}d${depth}`).join("/")}/a.bin`, contents: Buffer.from([row]),
  }));
  const wide = await makeCoordinatorFixture(rows);
  session = await openSignedArtifactSession({ bundleRoot: wide.root });
  try { await session.readManifest(); await expect(session.openExpected(wide.manifest)).rejects.toThrow(coordinatorError); }
  finally { await session.close(); await rm(wide.root, { recursive: true, force: true }); }
});

test.runIf(process.platform === "win32")("rejects more than 512 physical entries", async () => {
  const fixture = await makeCoordinatorFixture();
  for (let index = 0; index < 513; index += 1) await writeFile(join(fixture.root, `extra-${index}.bin`), "x");
  const session = await openSignedArtifactSession({ bundleRoot: fixture.root });
  try { await session.readManifest(); await expect(session.openExpected(fixture.manifest)).rejects.toThrow(coordinatorError); }
  finally { await session.close(); await rm(fixture.root, { recursive: true, force: true }); }
});

test.runIf(process.platform === "win32")("rejects during native enumeration before materializing entry 513", async () => {
  const fixture = await makeCoordinatorFixture();
  try {
    for (let index = 0; index < 513; index += 1) await writeFile(join(fixture.root, `extra-${index}.bin`), "x");
    const coordinator = join(process.cwd(), "scripts", "signed-artifact-bundle-coordinator.mjs");
    const result = await runNodeCapture([coordinator, "--self-test", "in-loop-entry-budget", fixture.root]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      hook: "in-loop-entry-budget",
      outcome: "in-loop-entry-budget",
    });
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test.runIf(process.platform === "win32").each(["after-inner-snapshot", "after-inner-identity"])
  ("rejects a nested race %s via the internal self-test command", async (hook) => {
    const fixture = await makeCoordinatorFixture([{ path: "outer/inner/artifact.bin", contents: Buffer.from("artifact") }]);
    const coordinator = join(process.cwd(), "scripts", "signed-artifact-bundle-coordinator.mjs");
    await expect(promisify(execFile)(process.execPath, [coordinator, "--self-test", hook, fixture.root], {
      windowsHide: true,
    })).resolves.toMatchObject({ stdout: "" });
    await rm(fixture.root, { recursive: true, force: true });
  });

test.runIf(process.platform === "win32").each([
  "settlement-real-ancestor-swap",
  "post-terminal-check-mutation",
  "zero-byte-success",
  "pending-watcher-dispose",
  "constructor-partial-failure",
])("proves coordinator native race handling: %s", async (hook) => {
  const fixture = await makeCoordinatorFixture([{ path: "outer/inner/artifact.bin", contents: Buffer.from("artifact") }]);
  const coordinator = join(process.cwd(), "scripts", "signed-artifact-bundle-coordinator.mjs");
  try {
    await expect(promisify(execFile)(process.execPath, [coordinator, "--self-test", hook, fixture.root], {
      windowsHide: true,
    })).resolves.toMatchObject({ stdout: "" });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test.runIf(process.platform === "win32").each([
  ["initial-real-reparse-swap", "reparse-authority"],
  ["preopen-real-file-substitution", "identity-mismatch"],
  ["postopen-real-file-substitution", "identity-mismatch"],
  ["delayed-kernel-completion", "delayed-kernel-change"],
  ["notification-buffer-overflow", "notification-lost-evidence"],
])("returns the exact causal self-test outcome for %s", async (hook, outcome) => {
  const fixture = await makeCoordinatorFixture([{ path: "outer/inner/artifact.bin", contents: Buffer.from("artifact") }]);
  const coordinator = join(process.cwd(), "scripts", "signed-artifact-bundle-coordinator.mjs");
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [coordinator, "--self-test", hook, fixture.root], {
      windowsHide: true,
    });
    expect(JSON.parse(stdout)).toEqual({ hook, outcome });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test.runIf(process.platform === "win32")("terminates a hung coordinator descendant without touching an unrelated process", async () => {
  const fixture = await makeCoordinatorFixture();
  const coordinator = join(process.cwd(), "scripts", "signed-artifact-bundle-coordinator.mjs");
  const unrelated = (await import("node:child_process")).spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  try {
    await expect(promisify(execFile)(process.execPath, [coordinator, "--self-test", "hung-descendant-cleanup", fixture.root], {
      windowsHide: true,
      timeout: 15_000,
    })).resolves.toMatchObject({ stdout: "" });
    expect(unrelated.exitCode).toBeNull();
  } finally {
    unrelated.kill();
    await new Promise((resolve) => unrelated.once("close", resolve));
    await rm(fixture.root, { recursive: true, force: true });
  }
}, 20_000);

test.runIf(process.platform === "win32")("redacts path, PID, and raw PowerShell detail from coordinator errors", async () => {
  const root = join(tmpdir(), `intentarc-signed-artifact-secret-${process.pid}`);
  const session = await openSignedArtifactSession({ bundleRoot: root });
  let thrown: unknown;
  try { await session.readManifest(); } catch (error) { thrown = error; }
  try { await session.close(); } catch {}
  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error).message).toBe(coordinatorError);
  expect((thrown as Error).message).not.toContain(root);
  expect((thrown as Error).message).not.toContain(String(process.pid));
  expect((thrown as Error).message).not.toMatch(/PowerShell|CreateFile|stack|line/i);
});
const validManifest = () => ({
  schemaVersion: 1,
  bundleId: "signed-artifact-only-20260813-01",
  source: { commit: "a".repeat(40), verifierSha256: "b".repeat(64), packageVersion: "0.0.9" },
  publisher: { cerSha256: "c".repeat(64), subject: "CN=IntentArc Artifact Test", thumbprint: "D".repeat(40) },
  files: [
    { path: "dist/bridge/IntentArc Bridge.exe", bytes: 16, sha256: "e".repeat(64) },
    { path: "out/IntentArc-win32-x64/IntentArc.exe", bytes: 16, sha256: "f".repeat(64) },
    { path: "out/make/squirrel.windows/x64/IntentArc Setup.exe", bytes: 16, sha256: "1".repeat(64) },
    { path: "out/make/squirrel.windows/x64/IntentArc-0.0.9-full.nupkg", bytes: 16, sha256: "2".repeat(64) },
    { path: "out/make/squirrel.windows/x64/RELEASES", bytes: 16, sha256: "3".repeat(64) },
  ],
  verification: { releaseExecutables: true, bridgeNative: true, bundleClosure: true },
});
const validResult = () => ({
  schemaVersion: 1,
  bundleId: "signed-artifact-only-20260813-01",
  sourceCommit: "a".repeat(40),
  verifierSha256: "b".repeat(64),
  packageVersion: "0.0.9",
  fileCount: 5,
  totalBytes: 80,
  publisher: { cerSha256: "c".repeat(64), subject: "CN=IntentArc Artifact Test", thumbprint: "D".repeat(40) },
  releaseExecutablesVerified: true,
  bridgeNativeVerified: true,
  bundleClosureVerified: true,
  bridgeDiagnosticInvocationCount: 0,
});
const expectManifestInvalid = (document: unknown) =>
  expect(() => validateSignedArtifactManifest(document)).toThrow(manifestError);
const orderManifestFiles = (manifest: ReturnType<typeof validManifest>) => {
  manifest.files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return manifest;
};

test("accepts the canonical signed artifact manifest", () => {
  expect(validateSignedArtifactManifest(validManifest())).toEqual(validManifest());
});

test("mutation unknown-key fails at closed manifest keys", async () => {
  const module = await importMutatedVerifier({
    name: "unknown-key",
    before: "if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) return false;",
    after: "if (names.slice(0, expected.length).some((name, index) => name !== expected[index])) return false;",
  });
  await expectMutantKilledAt("unknown-key", "rejects an unknown root key", async () => {
    expect(
      () => module.validateSignedArtifactManifest({ ...validManifest(), zzExtra: true }),
      "[mutant:unknown-key] rejects an unknown root key",
    ).toThrow(manifestError);
  });
});

test.each([
  ["unknown root key", (m: any) => ({ ...m, extra: true })],
  ["unknown source key", (m: any) => ({ ...m, source: { ...m.source, extra: true } })],
  ["unknown publisher key", (m: any) => ({ ...m, publisher: { ...m.publisher, extra: true } })],
  ["unknown file key", (m: any) => ({ ...m, files: [{ ...m.files[0], extra: true }, ...m.files.slice(1)] })],
  ["unknown verification key", (m: any) => ({ ...m, verification: { ...m.verification, extra: true } })],
  ["wrong schema version", (m: any) => ({ ...m, schemaVersion: 2 })],
  ["invalid commit", (m: any) => ({ ...m, source: { ...m.source, commit: "A".repeat(40) } })],
  ["invalid sha", (m: any) => ({ ...m, source: { ...m.source, verifierSha256: "B".repeat(64) } })],
  ["invalid thumbprint", (m: any) => ({ ...m, publisher: { ...m.publisher, thumbprint: "d".repeat(40) } })],
  ["invalid package version", (m: any) => ({ ...m, source: { ...m.source, packageVersion: "v0.0.9" } })],
  ["non-boolean verification", (m: any) => ({ ...m, verification: { ...m.verification, bridgeNative: "true" } })],
  ["invalid byte count", (m: any) => ({ ...m, files: [{ ...m.files[0], bytes: -1 }, ...m.files.slice(1)] })],
  ["custom prototype", (m: any) => Object.assign(Object.create({ inherited: true }), m)],
  ["files is not an array", (m: any) => ({ ...m, files: {} })],
  ["duplicate paths", (m: any) => ({ ...m, files: [...m.files, { ...m.files[4], sha256: "4".repeat(64) }] })],
  ["unsorted paths", (m: any) => ({ ...m, files: [...m.files].reverse() })],
  ["rooted path", (m: any) => ({ ...m, files: [{ ...m.files[0], path: "/bridge.exe" }, ...m.files.slice(1)] })],
  ["backslash path", (m: any) => ({ ...m, files: [{ ...m.files[0], path: "dist\\bridge.exe" }, ...m.files.slice(1)] })],
  ["dot segment path", (m: any) => ({ ...m, files: [{ ...m.files[0], path: "dist/../bridge.exe" }, ...m.files.slice(1)] })],
  ["control character path", (m: any) => ({ ...m, files: [{ ...m.files[0], path: "dist/bridge\u0000.exe" }, ...m.files.slice(1)] })],
  ["non-NFC path", (m: any) => ({ ...m, files: [{ ...m.files[0], path: "dist/e\u0301.exe" }, ...m.files.slice(1)] })],
  ["too many rows", (m: any) => ({ ...m, files: Array.from({ length: 65 }, (_, i) => ({ path: `a/${String(i).padStart(2, "0")}.exe`, bytes: 1, sha256: i.toString(16).padStart(64, "0") })) })],
  ["aggregate bytes over 4 GiB", (m: any) => ({ ...m, files: m.files.map((file: any, index: number) => ({ ...file, bytes: index === 0 ? 4 * 1024 * 1024 * 1024 + 1 : 0 })) })],
  ["manifest name in files", (m: any) => ({ ...m, files: [...m.files, { path: "z/bundle.json", bytes: 1, sha256: "4".repeat(64) }] })],
  ["publisher name in files", (m: any) => ({ ...m, files: [...m.files, { path: "z/publisher.cer", bytes: 1, sha256: "4".repeat(64) }] })],
])("rejects a closed-schema violation: %s", (_name, change) => {
  expectManifestInvalid(change(validManifest()));
});

test.each([
  ["drive-rooted", "C:/bridge.exe"],
  ["drive-relative", "C:bridge.exe"],
  ["forward-slash UNC", "//server/share/bridge.exe"],
  ["backslash UNC", "\\\\server\\share\\bridge.exe"],
  ["forward-slash device", "//?/C:/bridge.exe"],
  ["backslash device", "\\\\?\\C:\\bridge.exe"],
  ["forward-slash rooted", "/bridge.exe"],
  ["backslash rooted", "\\bridge.exe"],
])("rejects an ordered Windows or rooted path: %s", (_name, path) => {
  const manifest = validManifest();
  manifest.files = [{ ...manifest.files[0], path }, ...manifest.files.slice(1)];
  expectManifestInvalid(manifest);
});

test.each([
  ["top-level build log", "logs/build.log"],
  ["unexpected dist leaf", "dist/unexpected.exe"],
  ["unexpected out leaf", "out/diagnostics.log"],
  ["credential-shaped row", "credentials/credential-metadata.txt"],
  ["key-shaped row", "secrets/private.key"],
])("rejects an ordered out-of-layout manifest row: %s", (_name, path) => {
  const manifest = validManifest();
  manifest.files.push({ path, bytes: 1, sha256: "4".repeat(64) });
  expectManifestInvalid(orderManifestFiles(manifest));
});

test.each([
  ["extra named key", (files: any[]) => { (files as any).extra = true; }],
  ["symbol key", (files: any[]) => { (files as any)[Symbol("extra")] = true; }],
  ["custom prototype", (files: any[]) => { Object.setPrototypeOf(files, Object.create(Array.prototype)); }],
  ["hole", (files: any[]) => { delete files[0]; }],
  ["accessor index", (files: any[]) => {
    const first = files[0];
    Object.defineProperty(files, "0", { enumerable: true, configurable: true, get: () => first });
  }],
  ["non-enumerable index", (files: any[]) => {
    Object.defineProperty(files, "0", { enumerable: false, configurable: true, writable: true, value: files[0] });
  }],
])("rejects a non-closed files array: %s", (_name, mutate) => {
  const manifest = validManifest();
  mutate(manifest.files);
  expectManifestInvalid(manifest);
});

test.each([
  "README", "artifact.txt", "artifact.json", "artifact.xml", "artifact.yaml", "artifact.zip", "artifact.dll", "artifact.msi", "artifact.ps1", "artifact.log", "artifact.tmp", "credentials", "private.key", "signing.pfx", "artifact.cer", "nested/RELEASES",
])("rejects disallowed Squirrel companion %s", (leaf) => {
  const manifest = validManifest();
  manifest.files.push({ path: `out/make/squirrel.windows/x64/${leaf}`, bytes: 1, sha256: "4".repeat(64) });
  expectManifestInvalid(orderManifestFiles(manifest));
});

test.each([
  ["duplicate Setup-like executable", (m: any) => ({ ...m, files: [...m.files, { ...m.files[2], path: "out/make/squirrel.windows/x64/Other Setup.exe", sha256: "4".repeat(64) }] })],
  ["no Setup", (m: any) => ({ ...m, files: m.files.filter((file: any) => !file.path.endsWith("Setup.exe")) })],
  ["no full nupkg", (m: any) => ({ ...m, files: m.files.filter((file: any) => !file.path.endsWith("-full.nupkg")) })],
  ["two full nupkgs", (m: any) => ({ ...m, files: [...m.files, { path: "out/make/squirrel.windows/x64/IntentArc-0.0.8-full.nupkg", bytes: 1, sha256: "4".repeat(64) }] })],
])("rejects incomplete Squirrel policy: %s", (_name, change) => expectManifestInvalid(orderManifestFiles(change(validManifest()))));

test("accepts explicitly listed non-Setup Squirrel exe and nupkg companions", () => {
  const manifest = validManifest();
  manifest.files.push(
    { path: "out/make/squirrel.windows/x64/IntentArc-0.0.9-delta.nupkg", bytes: 1, sha256: "4".repeat(64) },
    { path: "out/make/squirrel.windows/x64/Update.exe", bytes: 1, sha256: "5".repeat(64) },
  );
  orderManifestFiles(manifest);
  expect(validateSignedArtifactManifest(manifest)).toEqual(manifest);
});

const publicDer = Buffer.from("MIICfzCCAegCCQDxxeXw914Y2DANBgkqhkiG9w0BAQsFADCBgzELMAkGA1UEBhMCSU4xEzARBgNVBAgMClN5bnRoZXRpY1gxEDAOBgNVBAcMB0V4YW1wbGUxFDASBgNVBAoMC0V4YW1wbGUgSW5jMRUwEwYDVQQDDAxUZXN0IEZpeHR1cmUxIDAeBgkqhkiG9w0BCQEWEXRlc3RAZXhhbXBsZS50ZXN0MB4XDTIwMDkwOTA1NTExN1oXDTIwMTAwOTA1NTExN1owgYMxCzAJBgNVBAYTAklOMRMwEQYDVQQIDApTeW50aGV0aWNYMRAwDgYDVQQHDAdFeGFtcGxlMRQwEgYDVQQKDAtFeGFtcGxlIEluYzEVMBMGA1UEAwwMVGVzdCBGaXh0dXJlMSAwHgYJKoZIhvcNAQkBFhF0ZXN0QGV4YW1wbGUudGVzdDCBnzANBgkqhkiG9w0BAQEFAAOBjQAwgYkCgYEAt/EfcF3FG4TneOBWr4JhOUdyuCXmDhy5yO3VKtQfPxr+5d0joCSnn/5vYDNSr1MfedZmqVxrXFoMAdPCd71BNmDmeLViQK61WREtASP0ZhQMoUBT+R3Fpdy0jPS0YoT/fBd96CJCmgsQOS8Tq5IKVeB61MyCkwAQ2Goe0T3sdVkCAwEAATANBgkqhkiG9w0BAQsFAAOBgQATe6ixdAjoV7BSHgRXbXM2+IZLq8kq3s7ck0EZrRVhsivutcaZwDXRCCinB+OlPedbzXwNZGvVX0nwPYHGBfiXwdiuZeVJ88ni6Fm6RhoPtu2QF1UExfBvSXuMBgR+evp+e3QadNpGx6Ppl1aChWF6W2H9+MAlU7yvtmCQQuZmfQ==", "base64");
// Parsing-only DER fixture with synthetic subject/issuer text. It is not a
// trusted or cryptographically re-signed certificate; these tests bind bytes
// and identity fields, while live Authenticode verification is separate.
const publicIdentity = {
  expectedSha256: "2a9f78fe2b713c8e1981c4b4771a2370c2d0e54583d6db457f65f5aaaf6ed16f",
  expectedSubject: "C=IN\nST=SyntheticX\nL=Example\nO=Example Inc\nCN=Test Fixture\nemailAddress=test@example.test",
  expectedThumbprint: "04D349E8B3F1DBBD0097B8ADF97780B42B7C55D2",
};

test("validates a same-buffer public publisher identity", () => {
  expect(validatePublisherBytes({ bytes: publicDer, ...publicIdentity })).toEqual(undefined);
  expect(createHash("sha256").update(publicDer).digest("hex")).toBe(publicIdentity.expectedSha256);
  expect(new X509Certificate(publicDer).subject).toBe(publicIdentity.expectedSubject);
});

test.each([
  ["malformed DER", { bytes: Buffer.from("not a certificate") }],
  ["hash mismatch", { expectedSha256: "0".repeat(64) }],
  ["subject mismatch", { expectedSubject: "CN=Wrong" }],
  ["thumbprint mismatch", { expectedThumbprint: "0".repeat(40) }],
])("rejects publisher %s", (_name, override) => {
  expect(() => validatePublisherBytes({ bytes: publicDer, ...publicIdentity, ...override })).toThrow(publisherError);
});

const validPublisherInput = () => ({ bytes: publicDer, ...publicIdentity });

test.each([
  ["undefined", () => undefined],
  ["null", () => null],
  ["number", () => 0],
  ["string", () => "publisher"],
  ["boolean", () => true],
  ["unknown key", () => ({ ...validPublisherInput(), extra: true })],
  ["accessor", () => {
    const input = validPublisherInput();
    Object.defineProperty(input, "expectedSha256", { enumerable: true, get: () => { throw new Error("detail escaped"); } });
    return input;
  }],
  ["custom prototype", () => Object.assign(Object.create({ inherited: true }), validPublisherInput())],
])("normalizes a malformed publisher input to the fixed error: %s", (_name, makeInput) => {
  let thrown: unknown;
  try {
    validatePublisherBytes(makeInput() as any);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error).message).toBe(publisherError);
});

test.each([0, 5])("accepts the closed signed artifact result with diagnostic count %i", (count) => {
  const result = { ...validResult(), bridgeDiagnosticInvocationCount: count };
  expect(validateSignedArtifactResult(result)).toEqual(result);
});

test.each([
  ["extra keys", (result: any) => ({ ...result, rawResult: {} })],
  ["path values", (result: any) => ({ ...result, path: "out/IntentArc.exe" })],
  ["wrong schema", (result: any) => ({ ...result, schemaVersion: 2 })],
  ["unbounded bundle identity", (result: any) => ({ ...result, bundleId: "x".repeat(257) })],
  ["inconsistent verification", (result: any) => ({ ...result, bridgeNativeVerified: false })],
  ["negative count", (result: any) => ({ ...result, fileCount: -1 })],
  ["unsafe byte total", (result: any) => ({ ...result, totalBytes: Number.MAX_SAFE_INTEGER + 1 })],
  ["missing diagnostic count", (result: any) => {
    const { bridgeDiagnosticInvocationCount: _removed, ...missing } = result;
    return missing;
  }],
  ["diagnostic count one", (result: any) => ({ ...result, bridgeDiagnosticInvocationCount: 1 })],
  ["diagnostic count two", (result: any) => ({ ...result, bridgeDiagnosticInvocationCount: 2 })],
  ["diagnostic count three", (result: any) => ({ ...result, bridgeDiagnosticInvocationCount: 3 })],
  ["diagnostic count four", (result: any) => ({ ...result, bridgeDiagnosticInvocationCount: 4 })],
  ["diagnostic count six", (result: any) => ({ ...result, bridgeDiagnosticInvocationCount: 6 })],
  ["larger safe diagnostic count", (result: any) => ({ ...result, bridgeDiagnosticInvocationCount: 42 })],
  ["negative diagnostic count", (result: any) => ({ ...result, bridgeDiagnosticInvocationCount: -1 })],
  ["fractional diagnostic count", (result: any) => ({ ...result, bridgeDiagnosticInvocationCount: 0.5 })],
  ["string diagnostic count", (result: any) => ({ ...result, bridgeDiagnosticInvocationCount: "5" })],
  ["true diagnostic count", (result: any) => ({ ...result, bridgeDiagnosticInvocationCount: true })],
  ["false diagnostic count", (result: any) => ({ ...result, bridgeDiagnosticInvocationCount: false })],
])("rejects a closed result: %s", (_name, change) => {
  expect(() => validateSignedArtifactResult(change(validResult()))).toThrow(resultError);
});

test("rejects incomplete signed artifact CLI commands", () => {
  expect(() => parseSignedArtifactArguments(["validate-manifest"])).toThrow("IntentArc signed artifact command is invalid.");
  expect(() => parseSignedArtifactArguments(["verify"])).toThrow("IntentArc signed artifact command is invalid.");
  expect(() => parseSignedArtifactArguments(["verify", "unexpected"])).toThrow("IntentArc signed artifact command is invalid.");
});

test("composes the tracked release verifiers in order and closes authoritative resources", async () => {
  const bundleRoot = "C:\\preserved-bundle";
  const auditRoot = "C:\\controlled-run";
  const auditPath = join(auditRoot, "bridge-diagnostics.tokens");
  const controlledTokens = ["identity", "predecessor", "identity", "predecessor", "identity"];
  const manifest = validManifest();
  manifest.publisher = {
    cerSha256: publicIdentity.expectedSha256,
    subject: publicIdentity.expectedSubject,
    thumbprint: publicIdentity.expectedThumbprint,
  };
  const rows = manifest.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }));
  const calls: string[] = [];
  const releaseTokens: string[] = [];
  const nativeTokens: string[] = [];
  const settle = vi.fn(async () => { calls.push("settle"); });
  const close = vi.fn(async () => { calls.push("close"); });
  const verifyReleaseExecutables = vi.fn(async () => {
    calls.push("release");
    releaseTokens.push("identity", "predecessor");
    return ["fixed-release-result"];
  });
  const verifyBridgeNativeArtifacts = vi.fn(async (input) => {
    calls.push("bridge");
    nativeTokens.push("identity");
    expect(input.extractionParent).toMatch(/[/\\]intentarc-signed-artifact-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect((await lstat(input.extractionParent)).isDirectory()).toBe(true);
    return { fixed: "bridge-result" };
  });
  const readManifest = vi.fn(async () => { calls.push("readManifest"); return Buffer.from(JSON.stringify(manifest)); });
  const openExpected = vi.fn(async () => { calls.push("openExpected"); return { publisherBytes: publicDer, rows }; });
  const openSignedArtifactSession = vi.fn(async () => {
    calls.push("openSession");
    return {
      readManifest,
      openExpected,
      settle,
      close,
    };
  });
  const readBridgeDiagnosticAudit = vi.fn(async () => {
    calls.push("audit");
    return controlledTokens;
  });
  const previousAuditRoot = process.env.INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_ROOT;
  const previousAuditPath = process.env.INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_PATH;
  process.env.INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_ROOT = auditRoot;
  process.env.INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_PATH = auditPath;
  vi.doMock("../../../scripts/signed-artifact-bundle-coordinator.mjs", () => ({
    openSignedArtifactSession,
  }));
  vi.doMock("../../../scripts/desktop-release.mjs", () => ({ verifyReleaseExecutables }));
  vi.doMock("../../../scripts/bridge-native-release.mjs", () => ({ verifyBridgeNativeArtifacts }));
  vi.doMock("../../../scripts/bridge-diagnostic-audit.mjs", () => ({
    bridgeDiagnosticTokens: Object.freeze(["identity", "predecessor", "identity", "predecessor", "identity"]),
    readBridgeDiagnosticAudit,
  }));
  vi.doMock("node:fs/promises", async (importOriginal) => {
    const original = await importOriginal<typeof import("node:fs/promises")>();
    return { ...original, rm: async (...arguments_: Parameters<typeof original.rm>) => {
      calls.push("remove");
      return original.rm(...arguments_);
    } };
  });
  try {
    const module = await import("../../../scripts/signed-artifact-bundle.mjs?task-3-composition-red");
    const result = await module.validateSignedArtifactBundle({
      bundleRoot,
      expectedPublisherThumbprint: publicIdentity.expectedThumbprint,
    });
    const fullNupkgPath = join(bundleRoot, "out", "make", "squirrel.windows", "x64", "IntentArc-0.0.9-full.nupkg");
    expect(openSignedArtifactSession).toHaveBeenCalledWith({ bundleRoot });
    expect(readManifest).toHaveBeenCalledWith();
    expect(openExpected).toHaveBeenCalledWith(manifest);
    const releaseInput = verifyReleaseExecutables.mock.calls[0][0];
    expect(Object.keys(releaseInput).sort()).toEqual(["environment", "outputRoot"]);
    expect(releaseInput.outputRoot).toBe(join(bundleRoot, "out"));
    expect(releaseInput.environment).toBe(process.env);
    const nativeInput = verifyBridgeNativeArtifacts.mock.calls[0][0];
    expect(Object.keys(nativeInput).sort()).toEqual([
      "distBridgeRoot", "environment", "expectedThumbprint", "extractionParent", "fullNupkgPath", "packagedRoot",
    ]);
    expect(nativeInput).toMatchObject({
      distBridgeRoot: join(bundleRoot, "dist", "bridge"),
      packagedRoot: join(bundleRoot, "out", "IntentArc-win32-x64"),
      fullNupkgPath,
      extractionParent: expect.any(String),
      expectedThumbprint: publicIdentity.expectedThumbprint,
    });
    expect(nativeInput.environment).toBe(process.env);
    expect(releaseTokens).toEqual(["identity", "predecessor"]);
    expect(nativeTokens).toEqual(["identity"]);
    expect(controlledTokens).toEqual(["identity", "predecessor", "identity", "predecessor", "identity"]);
    expect(readBridgeDiagnosticAudit).toHaveBeenCalledWith({ auditRoot, auditPath });
    expect(calls).toEqual(["openSession", "readManifest", "openExpected", "release", "bridge", "audit", "settle", "remove", "close"]);
    expect(result).toEqual({
      schemaVersion: 1,
      bundleId: manifest.bundleId,
      sourceCommit: manifest.source.commit,
      verifierSha256: manifest.source.verifierSha256,
      packageVersion: manifest.source.packageVersion,
      fileCount: 5,
      totalBytes: 80,
      publisher: manifest.publisher,
      releaseExecutablesVerified: true,
      bridgeNativeVerified: true,
      bundleClosureVerified: true,
      bridgeDiagnosticInvocationCount: 5,
    });
    const extractionParent = verifyBridgeNativeArtifacts.mock.calls[0][0].extractionParent;
    await expect(lstat(extractionParent)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    vi.doUnmock("../../../scripts/signed-artifact-bundle-coordinator.mjs");
    vi.doUnmock("../../../scripts/desktop-release.mjs");
    vi.doUnmock("../../../scripts/bridge-native-release.mjs");
    vi.doUnmock("../../../scripts/bridge-diagnostic-audit.mjs");
    vi.doUnmock("node:fs/promises");
    if (previousAuditRoot === undefined) delete process.env.INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_ROOT;
    else process.env.INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_ROOT = previousAuditRoot;
    if (previousAuditPath === undefined) delete process.env.INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_PATH;
    else process.env.INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_PATH = previousAuditPath;
  }
});

const loadCompositionCase = async (options: {
  manifest?: ReturnType<typeof validManifest>;
  manifestBytes?: Buffer;
  publisherBytes?: Buffer;
  rows?: Array<{ path: string; bytes: number; sha256: string }>;
  openExpectedError?: Error;
  releaseError?: Error;
  bridgeError?: Error;
  settlementError?: Error;
  closeError?: Error;
  cleanupError?: Error;
  dependencyExtras?: boolean;
  randomUuid?: string;
  auditRoot?: string;
  auditPath?: string;
  auditTokens?: string[];
} = {}, mutation?: VerifierMutation) => {
  vi.resetModules();
  const previousAuditRoot = process.env.INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_ROOT;
  const previousAuditPath = process.env.INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_PATH;
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    vi.doUnmock("../../../scripts/signed-artifact-bundle-coordinator.mjs");
    vi.doUnmock("../../../scripts/desktop-release.mjs");
    vi.doUnmock("../../../scripts/bridge-native-release.mjs");
    vi.doUnmock("../../../scripts/bridge-diagnostic-audit.mjs");
    vi.doUnmock("node:fs/promises");
    vi.doUnmock("node:crypto");
    if (previousAuditRoot === undefined) delete process.env.INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_ROOT;
    else process.env.INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_ROOT = previousAuditRoot;
    if (previousAuditPath === undefined) delete process.env.INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_PATH;
    else process.env.INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_PATH = previousAuditPath;
  };
  try {
    delete process.env.INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_ROOT;
    delete process.env.INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_PATH;
    if (options.auditRoot !== undefined) process.env.INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_ROOT = options.auditRoot;
    if (options.auditPath !== undefined) process.env.INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_PATH = options.auditPath;
    const manifest = options.manifest ?? validManifest();
    manifest.publisher = {
      cerSha256: publicIdentity.expectedSha256,
      subject: publicIdentity.expectedSubject,
      thumbprint: publicIdentity.expectedThumbprint,
    };
    const rows = options.rows ?? manifest.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }));
    const settle = vi.fn(async () => { if (options.settlementError) throw options.settlementError; });
    const close = vi.fn(async () => { if (options.closeError) throw options.closeError; });
    const openSignedArtifactSession = vi.fn(async () => ({
      readManifest: async () => options.manifestBytes ?? Buffer.from(JSON.stringify(manifest)),
      openExpected: async () => {
        if (options.openExpectedError) throw options.openExpectedError;
        return { publisherBytes: options.publisherBytes ?? publicDer, rows };
      },
      settle,
      close,
    }));
    const releaseTokens: string[] = [];
    const nativeTokens: string[] = [];
    const verifyReleaseExecutables = vi.fn(async () => {
      releaseTokens.push("identity", "predecessor");
      if (options.releaseError) throw options.releaseError;
      return options.dependencyExtras ? Object.assign(["fixed"], { injected: true }) : ["fixed"];
    });
    let extractionParent: string | undefined;
    const verifyBridgeNativeArtifacts = vi.fn(async (input) => {
      extractionParent = input.extractionParent;
      nativeTokens.push("identity");
      if (options.bridgeError) throw options.bridgeError;
      return options.dependencyExtras ? { fixed: true, injected: "ignored" } : { fixed: true };
    });
    vi.doMock("../../../scripts/signed-artifact-bundle-coordinator.mjs", () => ({ openSignedArtifactSession }));
    vi.doMock("../../../scripts/desktop-release.mjs", () => ({ verifyReleaseExecutables }));
    vi.doMock("../../../scripts/bridge-native-release.mjs", () => ({ verifyBridgeNativeArtifacts }));
    const readBridgeDiagnosticAudit = vi.fn(async () => options.auditTokens ?? [
      "identity", "predecessor", "identity", "predecessor", "identity",
    ]);
    vi.doMock("../../../scripts/bridge-diagnostic-audit.mjs", () => ({
      bridgeDiagnosticTokens: Object.freeze(["identity", "predecessor", "identity", "predecessor", "identity"]),
      readBridgeDiagnosticAudit,
    }));
    if (options.randomUuid) {
      vi.doMock("node:crypto", async (importOriginal) => ({
        ...(await importOriginal<typeof import("node:crypto")>()),
        randomUUID: () => options.randomUuid,
      }));
    }
    if (options.cleanupError) {
      vi.doMock("node:fs/promises", async (importOriginal) => ({
        ...(await importOriginal<typeof import("node:fs/promises")>()),
        rm: async () => { throw options.cleanupError; },
      }));
    }
    const module = mutation
      ? await importMutatedVerifier(mutation)
      : await import("../../../scripts/signed-artifact-bundle.mjs");
    return {
      module,
      openSignedArtifactSession,
      verifyReleaseExecutables,
      verifyBridgeNativeArtifacts,
      readBridgeDiagnosticAudit,
      releaseTokens,
      nativeTokens,
      settle,
      close,
      getExtractionParent: () => extractionParent,
      restore,
    };
  } catch (error) {
    restore();
    throw error;
  }
};

const expectVerificationCategory = async (promise: Promise<unknown>, category: string) => {
  let thrown: unknown;
  try { await promise; } catch (error) { thrown = error; }
  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error).message).toBe(`IntentArc signed artifact verification failed: ${category}.`);
  expect((thrown as Error).message).not.toMatch(/raw detail|secret|stack|PowerShell/i);
};

test("restores audit environment and real dependency modules when composition setup fails", async () => {
  const originalAuditRoot = process.env.INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_ROOT;
  const originalAuditPath = process.env.INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_PATH;
  const expectedAuditRoot = "C:\\original-controlled-run";
  const expectedAuditPath = "C:\\original-controlled-run\\bridge-diagnostics.tokens";
  process.env.INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_ROOT = expectedAuditRoot;
  process.env.INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_PATH = expectedAuditPath;
  try {
    await expect(loadCompositionCase({
      auditRoot: "C:\\fixture-controlled-run",
      auditPath: "C:\\fixture-controlled-run\\bridge-diagnostics.tokens",
    }, {
      name: "composition-setup-restoration",
      before: "const impossible composition setup mutation anchor = true;",
      after: "const impossible composition setup mutation anchor = false;",
    })).rejects.toThrow("Verifier mutant composition-setup-restoration requires exactly one source occurrence; found 0.");

    expect.soft(process.env.INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_ROOT).toBe(expectedAuditRoot);
    expect.soft(process.env.INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_PATH).toBe(expectedAuditPath);
    vi.resetModules();
    const [releaseModule, nativeModule, auditModule] = await Promise.all([
      import("../../../scripts/desktop-release.mjs"),
      import("../../../scripts/bridge-native-release.mjs"),
      import("../../../scripts/bridge-diagnostic-audit.mjs"),
    ]);
    expect.soft(releaseModule.createPnpmInvocation).toBeTypeOf("function");
    expect.soft(nativeModule.runBoundedWindowsSign).toBeTypeOf("function");
    expect.soft(auditModule.recordBridgeDiagnostic).toBeTypeOf("function");
  } finally {
    vi.doUnmock("../../../scripts/signed-artifact-bundle-coordinator.mjs");
    vi.doUnmock("../../../scripts/desktop-release.mjs");
    vi.doUnmock("../../../scripts/bridge-native-release.mjs");
    vi.doUnmock("../../../scripts/bridge-diagnostic-audit.mjs");
    vi.doUnmock("node:fs/promises");
    vi.doUnmock("node:crypto");
    if (originalAuditRoot === undefined) delete process.env.INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_ROOT;
    else process.env.INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_ROOT = originalAuditRoot;
    if (originalAuditPath === undefined) delete process.env.INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_PATH;
    else process.env.INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_PATH = originalAuditPath;
  }
});

test("isolates composition dependency mocks between tests (seed)", async () => {
  vi.resetModules();
  vi.doMock("../../../scripts/desktop-release.mjs", () => ({
    verifyReleaseExecutables: vi.fn(async () => ["fixture-release-result"]),
  }));
  const releaseModule = await import("../../../scripts/desktop-release.mjs");
  expect(releaseModule.verifyReleaseExecutables).toBeTypeOf("function");
  expect(Object.keys(releaseModule)).toEqual(["verifyReleaseExecutables"]);
});

test("isolates composition dependency mocks between tests (actual modules)", async () => {
  vi.resetModules();
  const releaseModule = await import("../../../scripts/desktop-release.mjs");
  expect(releaseModule.createPnpmInvocation).toBeTypeOf("function");
});

test("keeps all three preserved diagnostics active when audit accounting is absent", async () => {
  const fixture = await loadCompositionCase();
  try {
    const result = await fixture.module.validateSignedArtifactBundle({
      bundleRoot: "C:\\preserved-bundle",
      expectedPublisherThumbprint: publicIdentity.expectedThumbprint,
    });
    expect(fixture.releaseTokens).toEqual(["identity", "predecessor"]);
    expect(fixture.nativeTokens).toEqual(["identity"]);
    const releaseInput = fixture.verifyReleaseExecutables.mock.calls[0][0];
    expect(Object.keys(releaseInput).sort()).toEqual(["environment", "outputRoot"]);
    expect(releaseInput.outputRoot).toBe("C:\\preserved-bundle\\out");
    expect(releaseInput.environment).toBe(process.env);
    const nativeInput = fixture.verifyBridgeNativeArtifacts.mock.calls[0][0];
    expect(Object.keys(nativeInput).sort()).toEqual([
      "distBridgeRoot", "environment", "expectedThumbprint", "extractionParent", "fullNupkgPath", "packagedRoot",
    ]);
    expect(nativeInput).toMatchObject({
      distBridgeRoot: "C:\\preserved-bundle\\dist\\bridge",
      packagedRoot: "C:\\preserved-bundle\\out\\IntentArc-win32-x64",
      fullNupkgPath: "C:\\preserved-bundle\\out\\make\\squirrel.windows\\x64\\IntentArc-0.0.9-full.nupkg",
      extractionParent: expect.any(String),
      expectedThumbprint: publicIdentity.expectedThumbprint,
    });
    expect(nativeInput.environment).toBe(process.env);
    expect(fixture.readBridgeDiagnosticAudit).not.toHaveBeenCalled();
    expect(result.bridgeDiagnosticInvocationCount).toBe(0);
  } finally { fixture.restore(); }
});

test("reports five diagnostics only after reading the exact controlled audit", async () => {
  const auditRoot = "C:\\controlled-run";
  const auditPath = "C:\\controlled-run\\bridge-diagnostics.tokens";
  const fixture = await loadCompositionCase({
    auditRoot,
    auditPath,
    auditTokens: ["identity", "predecessor", "identity", "predecessor", "identity"],
  });
  try {
    const result = await fixture.module.validateSignedArtifactBundle({
      bundleRoot: "C:\\preserved-bundle",
      expectedPublisherThumbprint: publicIdentity.expectedThumbprint,
    });
    expect(fixture.releaseTokens).toEqual(["identity", "predecessor"]);
    expect(fixture.nativeTokens).toEqual(["identity"]);
    expect(fixture.readBridgeDiagnosticAudit).toHaveBeenCalledWith({ auditRoot, auditPath });
    expect(result.bridgeDiagnosticInvocationCount).toBe(5);
    expect(Object.keys(result).sort()).toEqual([
      "bridgeDiagnosticInvocationCount", "bridgeNativeVerified", "bundleClosureVerified", "bundleId", "fileCount",
      "packageVersion", "publisher", "releaseExecutablesVerified", "schemaVersion", "sourceCommit", "totalBytes",
      "verifierSha256",
    ]);
  } finally { fixture.restore(); }
});

test.each([
  ["root only", { auditRoot: "C:\\controlled-run" }],
  ["path only", { auditPath: "C:\\controlled-run\\bridge-diagnostics.tokens" }],
])("maps partial diagnostic audit environment (%s) to bridge-diagnostic-audit before executable proofs", async (_name, audit) => {
  const fixture = await loadCompositionCase(audit);
  try {
    await expectVerificationCategory(fixture.module.validateSignedArtifactBundle({
      bundleRoot: "C:\\preserved-bundle",
      expectedPublisherThumbprint: publicIdentity.expectedThumbprint,
    }), "bridge-diagnostic-audit");
    expect(fixture.releaseTokens).toEqual([]);
    expect(fixture.nativeTokens).toEqual([]);
    expect(fixture.verifyReleaseExecutables).not.toHaveBeenCalled();
    expect(fixture.verifyBridgeNativeArtifacts).not.toHaveBeenCalled();
    expect(fixture.readBridgeDiagnosticAudit).not.toHaveBeenCalled();
    expect(fixture.settle).not.toHaveBeenCalled();
    expect(fixture.close).toHaveBeenCalledOnce();
  } finally { fixture.restore(); }
});

test.each([
  ["partial", ["identity", "predecessor", "identity"]],
  ["reordered", ["predecessor", "identity", "identity", "predecessor", "identity"]],
  ["sixth", ["identity", "predecessor", "identity", "predecessor", "identity", "identity"]],
])("maps a %s controlled diagnostic audit to bridge-diagnostic-audit", async (_name, auditTokens) => {
  const fixture = await loadCompositionCase({
    auditRoot: "C:\\controlled-run",
    auditPath: "C:\\controlled-run\\bridge-diagnostics.tokens",
    auditTokens,
  });
  try {
    await expectVerificationCategory(fixture.module.validateSignedArtifactBundle({
      bundleRoot: "C:\\preserved-bundle",
      expectedPublisherThumbprint: publicIdentity.expectedThumbprint,
    }), "bridge-diagnostic-audit");
    expect(fixture.releaseTokens).toEqual(["identity", "predecessor"]);
    expect(fixture.nativeTokens).toEqual(["identity"]);
    expect(fixture.readBridgeDiagnosticAudit).toHaveBeenCalledOnce();
    expect(fixture.settle).not.toHaveBeenCalled();
    expect(fixture.close).toHaveBeenCalledOnce();
  } finally { fixture.restore(); }
});

test("mutation path-safety fails at dot-segment rejection", async () => {
  const module = await importMutatedVerifier({
    name: "path-safety",
    before: 'return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");',
    after: 'return segments.every((segment) => segment !== "" && segment !== ".");',
  });
  const manifest = validManifest();
  manifest.files[0].path = "dist/bridge/../bridge.exe";
  await expectMutantKilledAt("path-safety", "rejects a dot segment", async () => {
    expect(
      () => module.validateSignedArtifactManifest(manifest),
      "[mutant:path-safety] rejects a dot segment",
    ).toThrow(manifestError);
  });
});

test("mutation allowed-root-closure fails before verifier composition", async () => {
  const manifest = validManifest();
  manifest.files.push({
    path: "credentials/credential-metadata.txt",
    bytes: 1,
    sha256: "4".repeat(64),
  });
  orderManifestFiles(manifest);
  const fixture = await loadCompositionCase({ manifest }, {
    name: "allowed-root-closure",
    before: "|| !isAllowedPayloadPath(file.path)\n        || !Number.isSafeInteger(file.bytes)",
    after: "|| !Number.isSafeInteger(file.bytes)",
  });
  try {
    await expectMutantKilledAt("allowed-root-closure", "rejects a credential-shaped row before verifiers", async () => {
      await expectRejectedAt(
        fixture.module.validateSignedArtifactBundle({
          bundleRoot: "C:\\preserved-bundle",
          expectedPublisherThumbprint: publicIdentity.expectedThumbprint,
        }),
        "[mutant:allowed-root-closure] rejects a credential-shaped row before verifiers",
        "IntentArc signed artifact verification failed: manifest.",
      );
      expect(
        fixture.verifyReleaseExecutables,
        "[mutant:allowed-root-closure] rejects a credential-shaped row before verifiers",
      ).not.toHaveBeenCalled();
      expect(
        fixture.verifyBridgeNativeArtifacts,
        "[mutant:allowed-root-closure] rejects a credential-shaped row before verifiers",
      ).not.toHaveBeenCalled();
    });
  } finally { fixture.restore(); }
});

test("mutation ordinal-order fails at duplicate-path rejection", async () => {
  const module = await importMutatedVerifier({
    name: "ordinal-order",
    before: '(previousPath !== "" && previousPath >= file.path)',
    after: '(previousPath !== "" && previousPath > file.path)',
  });
  const manifest = validManifest();
  manifest.files.splice(1, 0, { ...manifest.files[0] });
  await expectMutantKilledAt("ordinal-order", "rejects an ordinal duplicate", async () => {
    expect(
      () => module.validateSignedArtifactManifest(manifest),
      "[mutant:ordinal-order] rejects an ordinal duplicate",
    ).toThrow(manifestError);
  });
});

test.runIf(process.platform === "win32")("mutation single-link fails at hard-link rejection", async () => {
  const module = await importMutatedVerifier({
    name: "single-link",
    before: "if (($info.Attributes -band 0x10) -ne 0 -or ($info.Attributes -band 0x400) -ne 0 -or\n      $info.NumberOfLinks -ne 1) { throw 'coordinator' }",
    after: "if (($info.Attributes -band 0x10) -ne 0 -or ($info.Attributes -band 0x400) -ne 0) { throw 'coordinator' }",
  });
  const fixture = await makeCoordinatorFixture();
  const outside = await mkdtemp(join(tmpdir(), "intentarc-signed-artifact-mutant-hardlink-"));
  await link(join(fixture.root, "payload", "artifact.bin"), join(outside, "artifact-link.bin"));
  await expectMutantKilledAt("single-link", "rejects a multiply linked artifact", async () => {
    const session = await module.openSignedArtifactSession({ bundleRoot: fixture.root });
    try {
      await session.readManifest();
      await expectRejectedAt(
        session.openExpected(fixture.manifest),
        "[mutant:single-link] rejects a multiply linked artifact",
        coordinatorError,
      );
    } finally {
      await session.close();
      await rm(fixture.root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test.runIf(process.platform === "win32")("mutation in-loop-entry-budget fails at native enumeration", async () => {
  const { mutantPath } = await createMutatedVerifier({
    name: "in-loop-entry-budget",
    before: "if (names.Count >= maximumEntries) {\n              SelfTestOutcome = \"in-loop-entry-budget\";\n              throw new IOException(\"entry-budget\");\n            }\n            names.Add(name);",
    after: "names.Add(name);",
  });
  const fixture = await makeCoordinatorFixture();
  try {
    for (let index = 0; index < 513; index += 1) await writeFile(join(fixture.root, `extra-${index}.bin`), "x");
    await expectMutantKilledAt("in-loop-entry-budget", "aborts before appending entry 513", async () => {
      const result = await runNodeCapture([mutantPath, "--self-test", "in-loop-entry-budget", fixture.root]);
      expect(
        result.exitCode,
        "[mutant:in-loop-entry-budget] aborts before appending entry 513",
      ).toBe(0);
      expect(
        JSON.parse(result.stdout),
        "[mutant:in-loop-entry-budget] aborts before appending entry 513",
      ).toEqual({ hook: "in-loop-entry-budget", outcome: "in-loop-entry-budget" });
    });
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("mutation early-json-bound fails before opening expected artifacts", async () => {
  const manifest = validManifest();
  manifest.publisher = {
    cerSha256: publicIdentity.expectedSha256,
    subject: publicIdentity.expectedSubject,
    thumbprint: publicIdentity.expectedThumbprint,
  };
  const manifestBytes = Buffer.concat([
    Buffer.from(JSON.stringify(manifest)),
    Buffer.alloc(2 * 1024 * 1024, 0x20),
  ]);
  const fixture = await loadCompositionCase({ manifest, manifestBytes }, {
    name: "early-json-bound",
    before: "const manifest = await runBoundary(\"manifest\", async () => {\n      if (!Buffer.isBuffer(manifestBytes) || manifestBytes.length > MAX_MANIFEST_BYTES) throw manifestError();",
    after: "const manifest = await runBoundary(\"manifest\", async () => {\n      if (!Buffer.isBuffer(manifestBytes)) throw manifestError();",
  });
  try {
    await expectMutantKilledAt("early-json-bound", "rejects oversized retained JSON before artifact opening", async () => {
      await expectRejectedAt(
        fixture.module.validateSignedArtifactBundle({
          bundleRoot: "C:\\preserved-bundle",
          expectedPublisherThumbprint: publicIdentity.expectedThumbprint,
        }),
        "[mutant:early-json-bound] rejects oversized retained JSON before artifact opening",
        "IntentArc signed artifact verification failed: manifest.",
      );
    });
  } finally { fixture.restore(); }
});

test("mutation early-publisher-bound fails before X.509 acceptance", async () => {
  const module = await importMutatedVerifier({
    name: "early-publisher-bound",
    before: "if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_PUBLISHER_BYTES\n      || !isSha256(expectedSha256) || !isSubject(expectedSubject) || !isThumbprint(expectedThumbprint)) throw publisherError();",
    after: "if (!Buffer.isBuffer(bytes) || bytes.length === 0\n      || !isSha256(expectedSha256) || !isSubject(expectedSubject) || !isThumbprint(expectedThumbprint)) throw publisherError();",
  });
  const oversized = Buffer.concat([publicDer, Buffer.alloc(64 * 1024 + 1 - publicDer.length)]);
  await expectMutantKilledAt("early-publisher-bound", "rejects oversized publisher bytes", async () => {
    expect(
      () => module.validatePublisherBytes({
        bytes: oversized,
        expectedSha256: sha256(oversized),
        expectedSubject: publicIdentity.expectedSubject,
        expectedThumbprint: publicIdentity.expectedThumbprint,
      }),
      "[mutant:early-publisher-bound] rejects oversized publisher bytes",
    ).toThrow(publisherError);
  });
});

test("mutation early-artifact-bound fails at the aggregate manifest limit", async () => {
  const module = await importMutatedVerifier({
    name: "early-artifact-bound",
    before: "if (totalBytes > MAX_AGGREGATE_BYTES) throw manifestError();",
    after: "if (totalBytes > MAX_AGGREGATE_BYTES + 1) throw manifestError();",
  });
  const manifest = validManifest();
  manifest.files = manifest.files.map((file, index) => ({
    ...file,
    bytes: index === 0 ? 4 * 1024 * 1024 * 1024 + 1 : 0,
  }));
  await expectMutantKilledAt("early-artifact-bound", "rejects aggregate artifact bytes above 4 GiB", async () => {
    expect(
      () => module.validateSignedArtifactManifest(manifest),
      "[mutant:early-artifact-bound] rejects aggregate artifact bytes above 4 GiB",
    ).toThrow(manifestError);
  });
});

test("mutation same-byte-x509 fails at byte-identity binding", async () => {
  const module = await importMutatedVerifier({
    name: "same-byte-x509",
    before: "const certificate = new X509Certificate(bytes);",
    after: 'const certificate = new X509Certificate(globalThis[Symbol.for("intentarc.test.mutated-publisher-bytes")]);',
  });
  (globalThis as Record<PropertyKey, unknown>)[sameByteMutationKey] = publicDer;
  const unrelatedBytes = Buffer.from("not the publisher certificate bytes");
  await expectMutantKilledAt("same-byte-x509", "rejects identity parsed from different bytes", async () => {
    expect(
      () => module.validatePublisherBytes({
        bytes: unrelatedBytes,
        expectedSha256: sha256(unrelatedBytes),
        expectedSubject: publicIdentity.expectedSubject,
        expectedThumbprint: publicIdentity.expectedThumbprint,
      }),
      "[mutant:same-byte-x509] rejects identity parsed from different bytes",
    ).toThrow(publisherError);
  });
});

test("mutation artifact-allowlist fails at a disallowed Squirrel companion", async () => {
  const module = await importMutatedVerifier({
    name: "artifact-allowlist",
    before: 'const allowedSquirrelExtensions = new Set([".exe", ".nupkg"]);',
    after: 'const allowedSquirrelExtensions = new Set([".dll", ".exe", ".nupkg"]);',
  });
  const manifest = validManifest();
  manifest.files.push({
    path: "out/make/squirrel.windows/x64/unlisted.dll",
    bytes: 1,
    sha256: "4".repeat(64),
  });
  orderManifestFiles(manifest);
  await expectMutantKilledAt("artifact-allowlist", "rejects an unlisted DLL companion", async () => {
    expect(
      () => module.validateSignedArtifactManifest(manifest),
      "[mutant:artifact-allowlist] rejects an unlisted DLL companion",
    ).toThrow(manifestError);
  });
});

test("mutation topology-budget fails at 65 manifest rows", async () => {
  const module = await importMutatedVerifier({
    name: "topology-budget",
    before: "const MAX_FILE_ROWS = 64;",
    after: "const MAX_FILE_ROWS = 65;",
  });
  const manifest = validManifest();
  manifest.files.push(...Array.from({ length: 60 }, (_, index) => ({
    path: `dist/bridge/mutant-${String(index).padStart(2, "0")}.bin`,
    bytes: 1,
    sha256: index.toString(16).padStart(64, "0"),
  })));
  orderManifestFiles(manifest);
  await expectMutantKilledAt("topology-budget", "rejects row 65", async () => {
    expect(
      () => module.validateSignedArtifactManifest(manifest),
      "[mutant:topology-budget] rejects row 65",
    ).toThrow(manifestError);
  });
});

test("mutation directory-settlement fails at the retained settlement boundary", async () => {
  const fixture = await loadCompositionCase({}, {
    name: "directory-settlement",
    before: 'await runBoundary("settlement", () => session.settle());',
    after: "await Promise.resolve();",
  });
  try {
    await expectMutantKilledAt("directory-settlement", "settles retained directories before return", async () => {
      await fixture.module.validateSignedArtifactBundle({
        bundleRoot: "C:\\preserved-bundle",
        expectedPublisherThumbprint: publicIdentity.expectedThumbprint,
      });
      expect(
        fixture.settle,
        "[mutant:directory-settlement] settles retained directories before return",
      ).toHaveBeenCalledOnce();
    });
  } finally { fixture.restore(); }
});

test("mutation closed-return fails at the serialized result schema", async () => {
  const fixture = await loadCompositionCase({}, {
    name: "closed-return",
    before: "      bundleClosureVerified: true,\n      bridgeDiagnosticInvocationCount,\n    });\n  } catch (error) {",
    after: "      bundleClosureVerified: true,\n      bridgeDiagnosticInvocationCount,\n    });\n    result.injected = true;\n  } catch (error) {",
  });
  try {
    await expectMutantKilledAt("closed-return", "returns only the closed result keys", async () => {
      const result = await fixture.module.validateSignedArtifactBundle({
        bundleRoot: "C:\\preserved-bundle",
        expectedPublisherThumbprint: publicIdentity.expectedThumbprint,
      });
      expect(
        Object.keys(result).sort(),
        "[mutant:closed-return] returns only the closed result keys",
      ).toEqual([
        "bridgeDiagnosticInvocationCount", "bridgeNativeVerified", "bundleClosureVerified", "bundleId", "fileCount", "packageVersion", "publisher",
        "releaseExecutablesVerified", "schemaVersion", "sourceCommit", "totalBytes", "verifierSha256",
      ]);
    });
  } finally { fixture.restore(); }
});

test("mutation cleanup-ownership fails before deleting an unclaimed UUID directory", async () => {
  const collisionUuid = randomUUID();
  const collisionParent = join(await realpath(tmpdir()), `intentarc-signed-artifact-${collisionUuid}`);
  const sentinelPath = join(collisionParent, "sentinel.txt");
  await mkdir(collisionParent);
  await writeFile(sentinelPath, "must survive");
  const fixture = await loadCompositionCase({ randomUuid: collisionUuid }, {
    name: "cleanup-ownership",
    before: "await runBoundary(\"bridge-native\", () => mkdir(extractionCandidate));\n    extractionParent = extractionCandidate;",
    after: "extractionParent = extractionCandidate;\n    await runBoundary(\"bridge-native\", () => mkdir(extractionCandidate));",
  });
  try {
    await expectMutantKilledAt("cleanup-ownership", "preserves an unclaimed collision directory", async () => {
      try {
        await fixture.module.validateSignedArtifactBundle({
          bundleRoot: "C:\\preserved-bundle",
          expectedPublisherThumbprint: publicIdentity.expectedThumbprint,
        });
      } catch {}
      let sentinel: string | undefined;
      try { sentinel = await readFile(sentinelPath, "utf8"); } catch {}
      expect(
        sentinel,
        "[mutant:cleanup-ownership] preserves an unclaimed collision directory",
      ).toBe("must survive");
    });
  } finally {
    fixture.restore();
    await rm(collisionParent, { recursive: true, force: true });
  }
});

test("mutation live-mode-rejection fails at the validation-only CLI boundary", async () => {
  const module = await importMutatedVerifier({
    name: "live-mode-rejection",
    before: '&& argumentsList[0] === "verify"',
    after: '&& (argumentsList[0] === "verify" || argumentsList[0] === "live")',
  });
  await expectMutantKilledAt("live-mode-rejection", "rejects a complete live-mode vector", async () => {
    expect(
      () => module.parseSignedArtifactArguments([
        "live", "--bundle", "C:\\evidence", "--expected-thumbprint", "A".repeat(40),
      ]),
      "[mutant:live-mode-rejection] rejects a complete live-mode vector",
    ).toThrow("IntentArc signed artifact command is invalid.");
  });
});

test.each([
  ["missing physical publisher", new Error("raw detail: publisher missing")],
  ["extra physical publisher", new Error("raw detail: extra publisher")],
])("maps %s to topology and stops before release verification", async (_name, openExpectedError) => {
  const fixture = await loadCompositionCase({ openExpectedError });
  try {
    await expectVerificationCategory(fixture.module.validateSignedArtifactBundle({
      bundleRoot: "C:\\preserved-bundle",
      expectedPublisherThumbprint: publicIdentity.expectedThumbprint,
    }), "topology");
    expect(fixture.verifyReleaseExecutables).not.toHaveBeenCalled();
    expect(fixture.verifyBridgeNativeArtifacts).not.toHaveBeenCalled();
  } finally { fixture.restore(); }
});

test("rejects a listed out-of-layout key-shaped row before either verifier runs", async () => {
  const manifest = validManifest();
  manifest.files.push({ path: "secrets/private.key", bytes: 1, sha256: "4".repeat(64) });
  orderManifestFiles(manifest);
  const fixture = await loadCompositionCase({ manifest });
  try {
    await expectVerificationCategory(fixture.module.validateSignedArtifactBundle({
      bundleRoot: "C:\\preserved-bundle",
      expectedPublisherThumbprint: publicIdentity.expectedThumbprint,
    }), "manifest");
    expect(fixture.verifyReleaseExecutables).not.toHaveBeenCalled();
    expect(fixture.verifyBridgeNativeArtifacts).not.toHaveBeenCalled();
  } finally { fixture.restore(); }
});

test.runIf(process.platform === "win32")("rejects a physically present listed out-of-layout credential row before verifier composition", async () => {
  const root = await mkdtemp(join(tmpdir(), "intentarc-out-of-layout-"));
  const verifyReleaseExecutables = vi.fn(async () => ["unused"]);
  const verifyBridgeNativeArtifacts = vi.fn(async () => ({ unused: true }));
  try {
    const path = "credentials/credential-metadata.txt";
    const contents = Buffer.from("metadata only");
    const manifest = validManifest();
    manifest.files.push({ path, bytes: contents.length, sha256: sha256(contents) });
    orderManifestFiles(manifest);
    await mkdir(join(root, "credentials"));
    await writeFile(join(root, ...path.split("/")), contents);
    await writeFile(join(root, "bundle.json"), JSON.stringify(manifest));
    vi.resetModules();
    vi.doUnmock("../../../scripts/signed-artifact-bundle-coordinator.mjs");
    vi.doMock("../../../scripts/desktop-release.mjs", () => ({ verifyReleaseExecutables }));
    vi.doMock("../../../scripts/bridge-native-release.mjs", () => ({ verifyBridgeNativeArtifacts }));
    const module = await import("../../../scripts/signed-artifact-bundle.mjs?physical-out-of-layout");
    await expectVerificationCategory(module.validateSignedArtifactBundle({
      bundleRoot: root,
      expectedPublisherThumbprint: manifest.publisher.thumbprint,
    }), "manifest");
    expect(verifyReleaseExecutables).not.toHaveBeenCalled();
    expect(verifyBridgeNativeArtifacts).not.toHaveBeenCalled();
  } finally {
    vi.doUnmock("../../../scripts/desktop-release.mjs");
    vi.doUnmock("../../../scripts/bridge-native-release.mjs");
    await rm(root, { recursive: true, force: true });
  }
});

test("maps an exact manifest-to-disk row mismatch to topology", async () => {
  const manifest = validManifest();
  const rows = manifest.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }));
  rows[0] = { ...rows[0], sha256: "9".repeat(64) };
  const fixture = await loadCompositionCase({ manifest, rows });
  try {
    await expectVerificationCategory(fixture.module.validateSignedArtifactBundle({
      bundleRoot: "C:\\preserved-bundle", expectedPublisherThumbprint: publicIdentity.expectedThumbprint,
    }), "topology");
    expect(fixture.verifyReleaseExecutables).not.toHaveBeenCalled();
  } finally { fixture.restore(); }
});

test("maps malformed retained manifest bytes to manifest and stops", async () => {
  const fixture = await loadCompositionCase({ manifestBytes: Buffer.from("{raw detail") });
  try {
    await expectVerificationCategory(fixture.module.validateSignedArtifactBundle({
      bundleRoot: "C:\\preserved-bundle", expectedPublisherThumbprint: publicIdentity.expectedThumbprint,
    }), "manifest");
    expect(fixture.verifyReleaseExecutables).not.toHaveBeenCalled();
  } finally { fixture.restore(); }
});

test("maps coordinator publisher-byte mismatch to publisher and stops", async () => {
  const fixture = await loadCompositionCase({ publisherBytes: Buffer.from("raw detail: not public DER") });
  try {
    await expectVerificationCategory(fixture.module.validateSignedArtifactBundle({
      bundleRoot: "C:\\preserved-bundle", expectedPublisherThumbprint: publicIdentity.expectedThumbprint,
    }), "publisher");
    expect(fixture.verifyReleaseExecutables).not.toHaveBeenCalled();
  } finally { fixture.restore(); }
});

test("rejects an independent publisher mismatch before opening expected files", async () => {
  const fixture = await loadCompositionCase();
  try {
    await expectVerificationCategory(fixture.module.validateSignedArtifactBundle({
      bundleRoot: "C:\\preserved-bundle", expectedPublisherThumbprint: "0".repeat(40),
    }), "publisher");
    expect(fixture.verifyReleaseExecutables).not.toHaveBeenCalled();
  } finally { fixture.restore(); }
});

test.each([
  ["release verifier", { releaseError: new Error("raw detail: release secret") }, "release-executables", false],
  ["bridge-native verifier", { bridgeError: new Error("raw detail: native secret") }, "bridge-native", true],
  ["settlement", { settlementError: new Error("raw detail: watcher secret") }, "settlement", true],
])("maps a %s failure and does not cross a later boundary", async (_name, options, category, bridgeCalled) => {
  const fixture = await loadCompositionCase(options);
  try {
    await expectVerificationCategory(fixture.module.validateSignedArtifactBundle({
      bundleRoot: "C:\\preserved-bundle", expectedPublisherThumbprint: publicIdentity.expectedThumbprint,
    }), category);
    expect(fixture.verifyBridgeNativeArtifacts).toHaveBeenCalledTimes(bridgeCalled ? 1 : 0);
  } finally { fixture.restore(); }
});

test.each([
  ["cleanup alone", {}],
  ["primary plus cleanup", { bridgeError: new Error("raw detail: primary") }],
])("makes %s authoritative as cleanup", async (_name, primary) => {
  const fixture = await loadCompositionCase({ ...primary, cleanupError: new Error("raw detail: cleanup secret") });
  try {
    await expectVerificationCategory(fixture.module.validateSignedArtifactBundle({
      bundleRoot: "C:\\preserved-bundle", expectedPublisherThumbprint: publicIdentity.expectedThumbprint,
    }), "cleanup");
  } finally {
    fixture.restore();
    const residue = fixture.getExtractionParent();
    if (residue) await rm(residue, { recursive: true, force: true });
  }
});

test("maps authoritative session close failure to cleanup", async () => {
  const fixture = await loadCompositionCase({ closeError: new Error("raw detail: close secret") });
  try {
    await expectVerificationCategory(fixture.module.validateSignedArtifactBundle({
      bundleRoot: "C:\\preserved-bundle", expectedPublisherThumbprint: publicIdentity.expectedThumbprint,
    }), "cleanup");
  } finally { fixture.restore(); }
});

test("does not claim or remove a UUID extraction parent when exclusive creation fails", async () => {
  const collisionUuid = randomUUID();
  const collisionParent = join(await realpath(tmpdir()), `intentarc-signed-artifact-${collisionUuid}`);
  const sentinelPath = join(collisionParent, "sentinel.txt");
  await mkdir(collisionParent);
  await writeFile(sentinelPath, "must survive");
  const before = await lstat(collisionParent);
  const fixture = await loadCompositionCase({ randomUuid: collisionUuid });
  try {
    await expectVerificationCategory(fixture.module.validateSignedArtifactBundle({
      bundleRoot: "C:\\preserved-bundle", expectedPublisherThumbprint: publicIdentity.expectedThumbprint,
    }), "bridge-native");
    expect(fixture.verifyBridgeNativeArtifacts).not.toHaveBeenCalled();
    const after = await lstat(collisionParent);
    expect({ dev: after.dev, ino: after.ino, birthtimeMs: after.birthtimeMs })
      .toEqual({ dev: before.dev, ino: before.ino, birthtimeMs: before.birthtimeMs });
    expect(await readFile(sentinelPath, "utf8")).toBe("must survive");
  } finally {
    fixture.restore();
    await rm(collisionParent, { recursive: true, force: true });
  }
});

test("does not serialize extra dependency result keys", async () => {
  const fixture = await loadCompositionCase({ dependencyExtras: true });
  try {
    const result = await fixture.module.validateSignedArtifactBundle({
      bundleRoot: "C:\\preserved-bundle", expectedPublisherThumbprint: publicIdentity.expectedThumbprint,
    });
    expect(Object.keys(result).sort()).toEqual([
      "bridgeDiagnosticInvocationCount", "bridgeNativeVerified", "bundleClosureVerified", "bundleId", "fileCount", "packageVersion", "publisher",
      "releaseExecutablesVerified", "schemaVersion", "sourceCommit", "totalBytes", "verifierSha256",
    ]);
    expect(JSON.stringify(result)).not.toContain("injected");
  } finally { fixture.restore(); }
});

test.each([
  ["extra input key", (module: any) => module.validateSignedArtifactBundle({ bundleRoot: "C:\\preserved-bundle", expectedPublisherThumbprint: publicIdentity.expectedThumbprint, verifySignature: vi.fn() })],
  ["second dependency argument", (module: any) => module.validateSignedArtifactBundle({ bundleRoot: "C:\\preserved-bundle", expectedPublisherThumbprint: publicIdentity.expectedThumbprint }, { openSession: vi.fn() })],
  ["custom prototype", (module: any) => module.validateSignedArtifactBundle(Object.assign(Object.create({ injected: true }), { bundleRoot: "C:\\preserved-bundle", expectedPublisherThumbprint: publicIdentity.expectedThumbprint }))],
  ["proxy", (module: any) => module.validateSignedArtifactBundle(new Proxy({}, { getPrototypeOf: () => { throw new Error("raw detail: proxy secret"); } }))],
  ["relative bundle root", (module: any) => module.validateSignedArtifactBundle({ bundleRoot: "preserved-bundle", expectedPublisherThumbprint: publicIdentity.expectedThumbprint })],
  ["lowercase thumbprint", (module: any) => module.validateSignedArtifactBundle({ bundleRoot: "C:\\preserved-bundle", expectedPublisherThumbprint: publicIdentity.expectedThumbprint.toLowerCase() })],
])("rejects attempted caller injection through %s", async (_name, invoke) => {
  const fixture = await loadCompositionCase();
  try {
    await expectVerificationCategory(invoke(fixture.module), "arguments");
    expect(fixture.openSignedArtifactSession).not.toHaveBeenCalled();
  } finally { fixture.restore(); }
});

test("rejects a transparent Proxy input before coordinator startup", async () => {
  const fixture = await loadCompositionCase();
  const input = new Proxy({
    bundleRoot: "C:\\preserved-bundle",
    expectedPublisherThumbprint: publicIdentity.expectedThumbprint,
  }, {});
  try {
    await expectVerificationCategory(fixture.module.validateSignedArtifactBundle(input), "arguments");
    expect(fixture.openSignedArtifactSession).not.toHaveBeenCalled();
  } finally { fixture.restore(); }
});

test("rejects a stateful Proxy before any reflection or field consumption", async () => {
  const fixture = await loadCompositionCase();
  const target = {
    bundleRoot: "C:\\preserved-bundle",
    expectedPublisherThumbprint: publicIdentity.expectedThumbprint,
  };
  let proxyOperations = 0;
  let bundleReads = 0;
  const input = new Proxy(target, {
    getPrototypeOf(value) { proxyOperations += 1; return Reflect.getPrototypeOf(value); },
    ownKeys(value) { proxyOperations += 1; return Reflect.ownKeys(value); },
    getOwnPropertyDescriptor(value, property) {
      proxyOperations += 1;
      return Reflect.getOwnPropertyDescriptor(value, property);
    },
    get(value, property, receiver) {
      proxyOperations += 1;
      if (property === "bundleRoot") {
        bundleReads += 1;
        return bundleReads === 1 ? Reflect.get(value, property, receiver) : "C:\\mutated-after-validation";
      }
      return Reflect.get(value, property, receiver);
    },
  });
  try {
    await expectVerificationCategory(fixture.module.validateSignedArtifactBundle(input), "arguments");
    expect(proxyOperations).toBe(0);
    expect(fixture.openSignedArtifactSession).not.toHaveBeenCalled();
  } finally { fixture.restore(); }
});

test("parses exact validation-only CLI vectors", () => {
  expect(parseSignedArtifactArguments(["validate-manifest", "--document", "C:\\evidence\\bundle.json"]))
    .toEqual({ command: "validate-manifest", documentPath: "C:\\evidence\\bundle.json" });
  expect(parseSignedArtifactArguments(["verify", "--bundle", "C:\\evidence", "--expected-thumbprint", "A".repeat(40)]))
    .toEqual({ bundleRoot: "C:\\evidence", command: "verify", expectedPublisherThumbprint: "A".repeat(40) });
});

test.each([
  ["relative manifest", ["validate-manifest", "--document", "bundle.json"]],
  ["relative bundle", ["verify", "--bundle", "bundle", "--expected-thumbprint", "A".repeat(40)]],
  ["extra argument", ["validate-manifest", "--document", "C:\\bundle.json", "extra"]],
  ["unknown mode", ["live", "--bundle", "C:\\evidence"]],
  ["mutant", ["verify", "--mutant", "C:\\evidence", "--expected-thumbprint", "A".repeat(40)]],
  ["build", ["build", "--bundle", "C:\\evidence"]],
  ["sign", ["sign", "--bundle", "C:\\evidence"]],
  ["lowercase thumbprint", ["verify", "--bundle", "C:\\evidence", "--expected-thumbprint", "a".repeat(40)]],
  ["environment-driven missing root", ["verify"]],
])("rejects CLI vector: %s", (_name, vector) => {
  expect(() => parseSignedArtifactArguments(vector)).toThrow("IntentArc signed artifact command is invalid.");
});

test.runIf(process.platform === "win32")("rejects a real oversized standalone manifest without full-file allocation or read", async () => {
  const root = await mkdtemp(join(tmpdir(), "intentarc-cli-manifest-bound-"));
  const documentPath = join(root, "oversized-bundle.json");
  try {
    const handle = await open(documentPath, "w");
    try { await handle.truncate(256 * 1024 * 1024); }
    finally { await handle.close(); }
    const script = join(process.cwd(), "scripts", "signed-artifact-bundle.mjs");
    const measured = await runMeasuredManifestCli(script, documentPath);
    expect(measured.exitCode).toBe(1);
    expect(measured.stdout).toBe("");
    expect(measured.stderr).toBe("IntentArc signed artifact verification failed: manifest.\n");
    expect(measured.peakWorkingSetBytes).toBeLessThan(128 * 1024 * 1024);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.runIf(process.platform === "win32")("mutation standalone-manifest-bound fails at the pre-copy file bound", async () => {
  const root = await mkdtemp(join(tmpdir(), "intentarc-cli-manifest-mutant-"));
  const documentPath = join(root, "oversized-bundle.json");
  try {
    const handle = await open(documentPath, "w");
    try { await handle.truncate(256 * 1024 * 1024); }
    finally { await handle.close(); }
    const { mutantPath } = await createMutatedVerifier({
      name: "standalone-manifest-bound",
      before: "if (information.size > MAX_MANIFEST_BYTES) throw manifestError();\n      const capacity = Math.min(information.size + 1, MAX_MANIFEST_BYTES + 1);",
      after: "const capacity = information.size;",
    });
    await expectMutantKilledAt("standalone-manifest-bound", "rejects before full-file allocation", async () => {
      const measured = await runMeasuredManifestCli(mutantPath, documentPath);
      expect(
        measured.peakWorkingSetBytes,
        "[mutant:standalone-manifest-bound] rejects before full-file allocation",
      ).toBeLessThan(128 * 1024 * 1024);
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("runs validate-manifest CLI with one minified closed JSON result", async () => {
  const root = await mkdtemp(join(tmpdir(), "intentarc-cli-manifest-"));
  const documentPath = join(root, "bundle.json");
  const manifest = orderManifestFiles(validManifest());
  await writeFile(documentPath, JSON.stringify(manifest));
  try {
    const script = join(process.cwd(), "scripts", "signed-artifact-bundle.mjs");
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [script, "validate-manifest", "--document", documentPath], {
      env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR }, windowsHide: true,
    });
    expect(stderr).toBe("");
    expect(stdout).toBe(`${JSON.stringify(manifest)}\n`);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("runs verify CLI through a test-only module hook and emits one closed result", async () => {
  const hookRoot = join(tmpdir(), `intentarc-signed-artifact-cli-${randomUUID()}`);
  const hookPath = join(hookRoot, "hook.mjs");
  const manifest = validManifest();
  manifest.publisher = {
    cerSha256: publicIdentity.expectedSha256,
    subject: publicIdentity.expectedSubject,
    thumbprint: publicIdentity.expectedThumbprint,
  };
  const rows = manifest.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }));
  const coordinatorSource = [
    `const manifest = Buffer.from(${JSON.stringify(Buffer.from(JSON.stringify(manifest)).toString("base64"))}, "base64");`,
    `const publisher = Buffer.from(${JSON.stringify(publicDer.toString("base64"))}, "base64");`,
    `const rows = JSON.parse(Buffer.from(${JSON.stringify(Buffer.from(JSON.stringify(rows)).toString("base64"))}, "base64").toString("utf8"));`,
    "export const openSignedArtifactSession = async () => ({",
    "readManifest: async () => manifest,",
    "openExpected: async () => ({ publisherBytes: publisher, rows }),",
    "settle: async () => undefined,",
    "close: async () => undefined,",
    "});",
  ].join("\n");
  const releaseSource = "export const verifyReleaseExecutables = async () => ['fixed-release'];";
  const bridgeSource = "export const verifyBridgeNativeArtifacts = async () => ({ fixed: 'bridge' });";
  const hookSource = [
    "import { registerHooks } from 'node:module';",
    `const sources = new Map(${JSON.stringify([
      ["./signed-artifact-bundle-coordinator.mjs", coordinatorSource],
      ["./desktop-release.mjs", releaseSource],
      ["./bridge-native-release.mjs", bridgeSource],
    ])});`,
    "registerHooks({ resolve(specifier, context, nextResolve) {",
    "if (sources.has(specifier) && context.parentURL?.endsWith('/scripts/signed-artifact-bundle.mjs')) {",
    "return { shortCircuit: true, url: `data:text/javascript;base64,${Buffer.from(sources.get(specifier)).toString('base64')}` };",
    "}",
    "return nextResolve(specifier, context);",
    "} });",
  ].join("\n");
  const expectedResult = {
    schemaVersion: 1,
    bundleId: "signed-artifact-only-20260813-01",
    sourceCommit: "a".repeat(40),
    verifierSha256: "b".repeat(64),
    packageVersion: "0.0.9",
    fileCount: 5,
    totalBytes: 80,
    publisher: manifest.publisher,
    releaseExecutablesVerified: true,
    bridgeNativeVerified: true,
    bundleClosureVerified: true,
    bridgeDiagnosticInvocationCount: 0,
  };
  let output: { stdout: string; stderr: string } | undefined;
  let exitCode: number | null | undefined;
  let commandError: unknown;
  await mkdir(hookRoot);
  try {
    await writeFile(hookPath, hookSource);
    const script = join(process.cwd(), "scripts", "signed-artifact-bundle.mjs");
    try {
      const child = spawnChild(process.execPath, [
        "--import", pathToFileURL(hookPath).href,
        script,
        "verify", "--bundle", "C:\\hooked-evidence", "--expected-thumbprint", publicIdentity.expectedThumbprint,
      ], {
        env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
      exitCode = await new Promise<number | null>((resolveExit, rejectExit) => {
        child.once("error", rejectExit);
        child.once("close", resolveExit);
      });
      output = { stdout, stderr };
    } catch (error) { commandError = error; }
  } finally {
    await rm(hookRoot, { recursive: true, force: true });
  }
  await expect(lstat(hookRoot)).rejects.toMatchObject({ code: "ENOENT" });
  if (commandError) throw commandError;
  expect(exitCode).toBe(0);
  expect(output).toEqual({ stdout: `${JSON.stringify(expectedResult)}\n`, stderr: "" });
});

test("runs malformed audit verification through the real CLI with its exact closed failure protocol", async () => {
  // Break caught: a verifier that always exits one makes the controller unable
  // to distinguish the bounded audit failure from unrelated verifier failures.
  const hookRoot = join(tmpdir(), `intentarc-signed-artifact-audit-cli-${randomUUID()}`);
  const hookPath = join(hookRoot, "hook.mjs");
  const manifest = validManifest();
  manifest.publisher = {
    cerSha256: publicIdentity.expectedSha256,
    subject: publicIdentity.expectedSubject,
    thumbprint: publicIdentity.expectedThumbprint,
  };
  const rows = manifest.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }));
  const coordinatorSource = [
    `const manifest = Buffer.from(${JSON.stringify(Buffer.from(JSON.stringify(manifest)).toString("base64"))}, "base64");`,
    `const publisher = Buffer.from(${JSON.stringify(publicDer.toString("base64"))}, "base64");`,
    `const rows = JSON.parse(Buffer.from(${JSON.stringify(Buffer.from(JSON.stringify(rows)).toString("base64"))}, "base64").toString("utf8"));`,
    "export const openSignedArtifactSession = async () => ({",
    "readManifest: async () => manifest,",
    "openExpected: async () => ({ publisherBytes: publisher, rows }),",
    "settle: async () => undefined,",
    "close: async () => undefined,",
    "});",
  ].join("\n");
  const releaseSource = "export const verifyReleaseExecutables = async () => ['fixed-release'];";
  const bridgeSource = "export const verifyBridgeNativeArtifacts = async () => ({ fixed: 'bridge' });";
  const auditSource = [
    "export const bridgeDiagnosticTokens = Object.freeze(['identity', 'predecessor', 'identity', 'predecessor', 'identity']);",
    "export const readBridgeDiagnosticAudit = async () => ['identity', 'predecessor', 'identity'];",
  ].join("\n");
  const hookSource = [
    "import { registerHooks } from 'node:module';",
    `const sources = new Map(${JSON.stringify([
      ["./signed-artifact-bundle-coordinator.mjs", coordinatorSource],
      ["./desktop-release.mjs", releaseSource],
      ["./bridge-native-release.mjs", bridgeSource],
      ["./bridge-diagnostic-audit.mjs", auditSource],
    ])});`,
    "registerHooks({ resolve(specifier, context, nextResolve) {",
    "if (sources.has(specifier) && context.parentURL?.endsWith('/scripts/signed-artifact-bundle.mjs')) {",
    "return { shortCircuit: true, url: `data:text/javascript;base64,${Buffer.from(sources.get(specifier)).toString('base64')}` };",
    "}",
    "return nextResolve(specifier, context);",
    "} });",
  ].join("\n");
  let output: { stdout: string; stderr: string } | undefined;
  let exitCode: number | null | undefined;
  let commandError: unknown;
  await mkdir(hookRoot);
  try {
    await writeFile(hookPath, hookSource);
    const script = join(process.cwd(), "scripts", "signed-artifact-bundle.mjs");
    try {
      const child = spawnChild(process.execPath, [
        "--import", pathToFileURL(hookPath).href,
        script,
        "verify", "--bundle", "C:\\hooked-evidence", "--expected-thumbprint", publicIdentity.expectedThumbprint,
      ], {
        env: {
          SystemRoot: process.env.SystemRoot,
          WINDIR: process.env.WINDIR,
          INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_ROOT: "C:\\controlled-run",
          INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_PATH: "C:\\controlled-run\\bridge-diagnostics.tokens",
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
      exitCode = await new Promise<number | null>((resolveExit, rejectExit) => {
        child.once("error", rejectExit);
        child.once("close", resolveExit);
      });
      output = { stdout, stderr };
    } catch (error) { commandError = error; }
  } finally {
    await rm(hookRoot, { recursive: true, force: true });
  }
  await expect(lstat(hookRoot)).rejects.toMatchObject({ code: "ENOENT" });
  if (commandError) throw commandError;
  expect(exitCode).toBe(2);
  expect(output).toEqual({
    stdout: "",
    stderr: "IntentArc signed artifact verification failed: bridge-diagnostic-audit.\n",
  });
});

test("writes only a fixed CLI failure category", async () => {
  const script = join(process.cwd(), "scripts", "signed-artifact-bundle.mjs");
  let failure: any;
  try {
    await promisify(execFile)(process.execPath, [script, "verify", "--bundle", "C:\\missing-secret-bundle", "--expected-thumbprint", "A".repeat(40)], {
      env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR }, windowsHide: true,
    });
  } catch (error) { failure = error; }
  expect(failure.code).toBe(1);
  expect(failure.stdout).toBe("");
  expect(failure.stderr).toBe("IntentArc signed artifact verification failed: manifest.\n");
  expect(failure.stderr).not.toContain("missing-secret-bundle");
});
