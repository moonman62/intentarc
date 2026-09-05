import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createWindowsSupervisorJobHostLaunch,
  observeWindowsJobMemberIdentity,
  parseWindowsSupervisorJobBootstrap,
  validateProductionSupervisorLaunchAuthority,
} from "./client-portability-windows-job.js";
import {
  observeWindowsSupervisorIdentity,
  terminateWindowsProcessIdentity,
} from "./client-portability-windows-settlement.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.runIf(process.platform === "win32")("Windows supervisor Job Object launch", () => {
  it("ignores ambient SystemRoot/WINDIR and creates an unpredictable exact host launch", () => {
    const originalSystemRoot = process.env.SystemRoot;
    const originalWindir = process.env.WINDIR;
    process.env.SystemRoot = "C:\\attacker";
    process.env.WINDIR = "C:\\attacker";
    try {
      const first = createWindowsSupervisorJobHostLaunch({
        nodeExecutable: process.execPath,
        supervisorBundle: resolve("dist/test-support/client-portability-session-supervisor.mjs"),
        runId: "123e4567-e89b-42d3-a456-426614174000",
        sessionId: "codex-123e4567-e89b-42d3-a456-426614174000",
        nonce: "a".repeat(64),
      });
      const second = createWindowsSupervisorJobHostLaunch({
        nodeExecutable: process.execPath,
        supervisorBundle: resolve("dist/test-support/client-portability-session-supervisor.mjs"),
        runId: "123e4567-e89b-42d3-a456-426614174000",
        sessionId: "codex-123e4567-e89b-42d3-a456-426614174000",
        nonce: "a".repeat(64),
      });

      expect(first.executable.toLowerCase()).toContain("\\windows\\system32\\");
      expect(JSON.stringify(first)).not.toContain("attacker");
      expect(first.options).toEqual(expect.objectContaining({
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      }));
      expect(first.options.env).toEqual(expect.objectContaining({
        SystemRoot: expect.stringMatching(/Windows$/i),
        WINDIR: expect.stringMatching(/Windows$/i),
        APPDATA: expect.any(String),
        TEMP: expect.any(String),
        USERPROFILE: expect.any(String),
      }));
      expect(first.jobName).toMatch(/^Local\\IntentArcPortability-[0-9a-f]{64}$/);
      expect(second.jobName).not.toBe(first.jobName);
      expect(first.arguments.join(" ")).not.toContain("Add-Type");
    } finally {
      if (originalSystemRoot === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = originalSystemRoot;
      if (originalWindir === undefined) delete process.env.WINDIR;
      else process.env.WINDIR = originalWindir;
    }
  });

  it("accepts only the exact inherited-pipe bootstrap binding", () => {
    const expected = {
      pid: 4120,
      startTime: "638914932000000000",
      jobName: `Local\\IntentArcPortability-${"b".repeat(64)}`,
      runId: "123e4567-e89b-42d3-a456-426614174000",
      sessionId: "codex-123e4567-e89b-42d3-a456-426614174000",
      nonce: "c".repeat(64),
    };
    const line = JSON.stringify({
      schema: "intentarc.client-portability-job/v1",
      ...expected,
    });
    expect(parseWindowsSupervisorJobBootstrap(line, expected)).toEqual({
      pid: expected.pid,
      startTime: expected.startTime,
    });
    expect(parseWindowsSupervisorJobBootstrap(line, { ...expected, jobName: `${expected.jobName}0` }))
      .toBeUndefined();
    expect(parseWindowsSupervisorJobBootstrap(JSON.stringify({
      schema: "intentarc.client-portability-job/v1",
      ...expected,
      extra: true,
    }), expected)).toBeUndefined();
  });

  it("rejects a PID-reused or out-of-job bridge on the same-handle membership result", async () => {
    const jobName = `Local\\IntentArcPortability-${"d".repeat(64)}`;
    await expect(observeWindowsJobMemberIdentity(7120, jobName, Date.now() + 1_000, {
      platform: "win32",
      inspectMember: async () => ({
        pid: 7120,
        startTime: "638914932000000010",
        jobMember: false,
      }),
    })).resolves.toBeUndefined();
    await expect(observeWindowsJobMemberIdentity(7120, jobName, Date.now() + 1_000, {
      platform: "win32",
      inspectMember: async () => ({
        pid: 7120,
        startTime: "638914932000000011",
        jobMember: true,
      }),
    })).resolves.toEqual({ pid: 7120, startTime: "638914932000000011" });
  });

  it("kills an unobserved late descendant after its intermediary exits", async () => {
    // Catches snapshot polling losing lineage after a bridge intermediary exits and reparents its child.
    const root = await mkdtemp(join(tmpdir(), "intentarc-portability-job-tree-"));
    roots.push(root);
    const grandchild = join(root, "grandchild.mjs");
    const intermediary = join(root, "intermediary.mjs");
    const supervisor = join(root, "supervisor.mjs");
    await Promise.all([
      writeFile(grandchild, "setInterval(() => undefined, 1000);\n"),
      writeFile(intermediary, [
        "import { spawn } from 'node:child_process';",
        `const child=spawn(process.execPath,[${JSON.stringify(grandchild)}],{detached:true,stdio:'ignore',windowsHide:true});`,
        "process.stdout.write(JSON.stringify({intermediaryPid:process.pid,grandchildPid:child.pid})+'\\n');",
      ].join("\n")),
      writeFile(supervisor, [
        "import { spawn } from 'node:child_process';",
        `const child=spawn(process.execPath,[${JSON.stringify(intermediary)}],{stdio:['ignore','pipe','pipe'],windowsHide:true});`,
        "child.stdout.pipe(process.stdout);",
        "setInterval(() => undefined, 1000);",
      ].join("\n")),
    ]);
    const launch = createWindowsSupervisorJobHostLaunch({
      nodeExecutable: process.execPath,
      supervisorBundle: supervisor,
      repositoryRoot: root,
      runId: "123e4567-e89b-42d3-a456-426614174000",
      sessionId: "codex-123e4567-e89b-42d3-a456-426614174000",
      nonce: "e".repeat(64),
    });
    const host = spawn(launch.executable, [...launch.arguments], {
      ...launch.options,
      env: { ...launch.options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let hostIdentity: { pid: number; startTime: string } | undefined;
    try {
      let buffered = "";
      const lines: string[] = [];
      const nextLine = async (): Promise<string> => {
        const existing = lines.shift();
        if (existing !== undefined) return existing;
        const bufferedNewline = buffered.indexOf("\n");
        if (bufferedNewline >= 0) {
          const line = buffered.slice(0, bufferedNewline).replace(/\r$/, "");
          buffered = buffered.slice(bufferedNewline + 1);
          return line;
        }
        return new Promise<string>((resolveLine, rejectLine) => {
          const timer = setTimeout(() => rejectLine(new Error("job fixture output timed out")), 5_000);
          const read = (chunk: Buffer): void => {
            buffered += chunk.toString("utf8");
            const newline = buffered.indexOf("\n");
            if (newline < 0) return;
            clearTimeout(timer);
            host.stdout.removeListener("data", read);
            const line = buffered.slice(0, newline).replace(/\r$/, "");
            buffered = buffered.slice(newline + 1);
            resolveLine(line);
          };
          host.stdout.on("data", read);
        });
      };
      const bootstrap = JSON.parse(await nextLine()) as { pid: number; startTime: string };
      hostIdentity = { pid: bootstrap.pid, startTime: bootstrap.startTime };
      const tree = JSON.parse(await nextLine()) as {
        intermediaryPid: number;
        grandchildPid: number;
      };
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      await expect(observeWindowsJobMemberIdentity(
        tree.grandchildPid,
        launch.jobName,
        Date.now() + 10_000,
      )).resolves.toEqual(expect.objectContaining({ pid: tree.grandchildPid }));
      const hostClosed = new Promise<void>((resolveClose) => {
        if (host.exitCode !== null) resolveClose();
        else host.once("close", () => resolveClose());
      });
      await expect(terminateWindowsProcessIdentity(
        hostIdentity,
        Date.now() + 10_000,
      )).resolves.toEqual({ status: "terminated" });
      await hostClosed;
      await expect(Promise.all([
        observeWindowsSupervisorIdentity(tree.intermediaryPid, Date.now() + 10_000),
        observeWindowsSupervisorIdentity(tree.grandchildPid, Date.now() + 10_000),
      ])).resolves.toEqual([undefined, undefined]);
    } finally {
      if (hostIdentity !== undefined && host.exitCode === null) {
        await terminateWindowsProcessIdentity(hostIdentity, Date.now() + 10_000);
      }
    }
  }, 20_000);

  it("proxies the assigned supervisor streams after the exact bootstrap", async () => {
    // Catches a job host that binds ownership but never forwards the supervisor protocol pipes.
    const root = await mkdtemp(join(tmpdir(), "intentarc-portability-job-proxy-"));
    roots.push(root);
    const supervisor = join(root, "supervisor.mjs");
    await writeFile(supervisor, [
      "process.stderr.write('fixture-ready\\n');",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.once('data', (chunk) => {",
      "  process.stderr.write('fixture-input\\n');",
      "  process.stdout.write(`echo:${chunk}`);",
      "  process.exit(0);",
      "});",
    ].join("\n"));
    const launch = createWindowsSupervisorJobHostLaunch({
      nodeExecutable: process.execPath,
      supervisorBundle: supervisor,
      repositoryRoot: root,
      runId: "123e4567-e89b-42d3-a456-426614174000",
      sessionId: "codex-123e4567-e89b-42d3-a456-426614174000",
      nonce: "f".repeat(64),
    });
    const host = spawn(launch.executable, [...launch.arguments], {
      ...launch.options,
      env: { ...launch.options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const nextLine = (
      stream: NodeJS.ReadableStream,
      label: string,
    ): Promise<string> => new Promise((resolveLine, rejectLine) => {
      let buffered = "";
      const timer = setTimeout(() => {
        stream.removeListener("data", read);
        rejectLine(new Error(`${label} timed out`));
      }, 5_000);
      const read = (chunk: Buffer): void => {
        buffered += chunk.toString("utf8");
        const newline = buffered.indexOf("\n");
        if (newline < 0) return;
        clearTimeout(timer);
        stream.removeListener("data", read);
        resolveLine(buffered.slice(0, newline).replace(/\r$/, ""));
      };
      stream.on("data", read);
    });
    let hostIdentity: { pid: number; startTime: string } | undefined;
    try {
      const bootstrapLine = nextLine(host.stdout, "bootstrap");
      const readyLine = nextLine(host.stderr, "supervisor stderr");
      const bootstrap = JSON.parse(await bootstrapLine) as {
        pid: number;
        startTime: string;
      };
      hostIdentity = { pid: bootstrap.pid, startTime: bootstrap.startTime };
      await expect(readyLine).resolves.toBe("fixture-ready");
      const stdoutLine = nextLine(host.stdout, "supervisor stdout");
      const inputLine = nextLine(host.stderr, "supervisor input acknowledgement");
      host.stdin.write("probe\n");
      await expect(inputLine).resolves.toBe("fixture-input");
      await expect(stdoutLine).resolves.toBe("echo:probe");
    } finally {
      if (hostIdentity !== undefined && host.exitCode === null) {
        await terminateWindowsProcessIdentity(hostIdentity, Date.now() + 10_000);
      }
    }
  }, 20_000);
});

describe("production launch authority", () => {
  it.runIf(process.platform === "win32")(
    "accepts canonical ordinary owned paths and rejects a reparse bridge",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "intentarc-portability-authority-"));
      roots.push(root);
      const repositoryRoot = join(root, "repository");
      const acceptanceRoot = join(root, "intentarc-client-portability-live-123e4567-e89b-42d3-a456-426614174000");
      const settingsRoot = join(acceptanceRoot, "Roaming", "IntentArc");
      const archivePath = join(acceptanceRoot, "intentarc.sqlite");
      const supervisorBundle = join(repositoryRoot, "supervisor.mjs");
      const bridgeExecutable = join(repositoryRoot, "IntentArc Bridge.exe");
      await Promise.all([
        mkdir(settingsRoot, { recursive: true }),
        mkdir(repositoryRoot, { recursive: true }),
      ]);
      await Promise.all([
        writeFile(archivePath, "archive"),
        writeFile(supervisorBundle, "supervisor"),
        writeFile(bridgeExecutable, "bridge"),
      ]);

      expect(validateProductionSupervisorLaunchAuthority({
        nodeExecutable: process.execPath,
        repositoryRoot,
        supervisorBundle,
        bridgeExecutable,
        settingsRoot,
        archivePath,
        acceptanceRoot,
      })).toEqual(expect.objectContaining({ bridgeExecutable, settingsRoot, archivePath }));

      const linkedTarget = join(repositoryRoot, "linked-target");
      const linkedDirectory = join(repositoryRoot, "linked-directory");
      await mkdir(linkedTarget);
      await writeFile(join(linkedTarget, "linked-bridge.exe"), "bridge");
      await symlink(linkedTarget, linkedDirectory, "junction");
      const linkedBridge = join(linkedDirectory, "linked-bridge.exe");
      expect(() => validateProductionSupervisorLaunchAuthority({
        nodeExecutable: process.execPath,
        repositoryRoot,
        supervisorBundle,
        bridgeExecutable: linkedBridge,
        settingsRoot,
        archivePath,
        acceptanceRoot,
      })).toThrow("Client portability supervisor launch is invalid.");

      const outsideBridge = join(dirname(root), `outside-${Date.now()}.exe`);
      await writeFile(outsideBridge, "outside");
      try {
        expect(() => validateProductionSupervisorLaunchAuthority({
          nodeExecutable: process.execPath,
          repositoryRoot,
          supervisorBundle,
          bridgeExecutable: outsideBridge,
          settingsRoot,
          archivePath,
          acceptanceRoot,
        })).toThrow("Client portability supervisor launch is invalid.");
      } finally {
        await rm(outsideBridge, { force: true });
      }
    },
  );
});
import { spawn } from "node:child_process";
