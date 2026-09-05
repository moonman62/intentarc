import { execFile as execFileCallback, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = process.cwd();
const scriptPath = join(repositoryRoot, "scripts", "desktop-release-preflight-once.ps1");
const powerShell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const productionManifestPath = "C:\\projects\\Project Manager\\.superpowers\\preflight-execution-authorizations\\phase1-preflight-envelope-20260902-01.json";
const authorizationKeys = [
  "schema", "attemptId", "controllerRunId", "jobName", "canonicalPath", "branch", "expectedCommit",
  "authorizationManifestPath", "envelopePath", "envelopeSha256", "controllerPath", "controllerSha256",
  "gitPath", "gitSha256", "nodePath", "nodeSha256", "cmdPath", "cmdSha256", "pnpmPath", "pnpmSha256",
  "outerPowerShellPath", "outerPowerShellSha256", "maximumControllerStdoutBytes",
  "maximumControllerStderrBytes", "maximumAttempts", "retryAuthorized", "restoreOnlyAuthorized",
  "signedReleaseAuthorized", "createdAtUtc",
] as const;
type AuthorizationKey = (typeof authorizationKeys)[number];

const authorizationLiteralTypes: Record<AuthorizationKey, "string" | "number" | "boolean"> = {
  schema: "string", attemptId: "string", controllerRunId: "string", jobName: "string", canonicalPath: "string",
  branch: "string", expectedCommit: "string", authorizationManifestPath: "string", envelopePath: "string",
  envelopeSha256: "string", controllerPath: "string", controllerSha256: "string", gitPath: "string",
  gitSha256: "string", nodePath: "string", nodeSha256: "string", cmdPath: "string", cmdSha256: "string",
  pnpmPath: "string", pnpmSha256: "string", outerPowerShellPath: "string", outerPowerShellSha256: "string",
  maximumControllerStdoutBytes: "number", maximumControllerStderrBytes: "number", maximumAttempts: "number",
  retryAuthorized: "boolean", restoreOnlyAuthorized: "boolean", signedReleaseAuthorized: "boolean", createdAtUtc: "string",
};
type WrongJsonType = "string" | "number" | "boolean" | "null" | "array" | "object" | "fractional";
const wrongJsonTypesByExpected = {
  string: ["number", "boolean", "null", "array", "object"],
  number: ["string", "boolean", "null", "array", "object", "fractional"],
  boolean: ["string", "number", "null", "array", "object"],
} as const satisfies Record<(typeof authorizationLiteralTypes)[AuthorizationKey], readonly WrongJsonType[]>;
const wrongAuthorizationTypeCases = authorizationKeys.flatMap((key) =>
  wrongJsonTypesByExpected[authorizationLiteralTypes[key]].map((wrongType) => [key, wrongType] as const),
);
const wrongJsonValue = (wrongType: WrongJsonType, original: unknown): unknown => ({
  string: String(original), number: 0, boolean: true, null: null, array: [original], object: { value: original }, fractional: 1.5,
})[wrongType];
const hashKeys = ["envelopeSha256", "controllerSha256", "gitSha256", "nodeSha256", "cmdSha256", "pnpmSha256", "outerPowerShellSha256"] as const satisfies readonly AuthorizationKey[];
const boundNames = ["envelope", "controller", "git", "node", "cmd", "pnpm", "host"] as const;
const auditKeys = ["schema", "status", "category", "attemptId", "controllerRunId", "expectedCommit", "attemptConsumed", "controllerStarted", "controllerExitCode", "resultSha256", "stateSha256", "receiptSha256", "outRestored", "cleanupComplete", "gitClean", "bindingsValid"] as const;
const expectedRefusal = {
  schema: "intentarc.preflight-execution-audit/v1", status: "TERMINAL-NOT-PASS", category: "authorization-invalid",
  attemptId: "phase1-preflight-envelope-20260902-01", controllerRunId: "phase1-preflight-20260901-06",
  expectedCommit: null, attemptConsumed: false, controllerStarted: false, controllerExitCode: null,
  resultSha256: null, stateSha256: null, receiptSha256: null, outRestored: false, cleanupComplete: false,
  gitClean: false, bindingsValid: false,
};

const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const caseDrift = (value: string) => value[0]!.toUpperCase() + value.slice(1);
type ProcessOutcome = { exitCode: number; stdout: string; stderr: string };

const runProcess = (arguments_: string[], options: { env?: NodeJS.ProcessEnv } = {}) => new Promise<ProcessOutcome>((resolve) => {
  execFileCallback(powerShell, arguments_, { windowsHide: true, env: options.env }, (error, stdout, stderr) => resolve({
    exitCode: error ? Number((error as NodeJS.ErrnoException).code ?? 1) : 0,
    stdout: String(stdout), stderr: String(stderr),
  }));
});

const runPowerShell = async (body: string) => {
  const outcome = await runProcess(["-NoProfile", "-NonInteractive", "-Command", body]);
  if (outcome.exitCode !== 0) throw new Error(`PowerShell failed (${outcome.exitCode}): ${outcome.stderr}\n${outcome.stdout}\nBODY:\n${body}`);
  return outcome.stdout.trim();
};

const runPowerShellScript = async (body: string) => {
  const root = await mkdtemp(join(tmpdir(), "intentarc powershell policy "));
  const path = join(root, "policy.ps1");
  try {
    await writeFile(path, "\uFEFF" + body, "utf8");
    const outcome = await runProcess(["-NoProfile", "-NonInteractive", "-File", path]);
    if (outcome.exitCode !== 0) throw new Error(`PowerShell failed (${outcome.exitCode}): ${outcome.stderr}\n${outcome.stdout}`);
    return outcome.stdout.trim();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

type Fixture = Awaited<ReturnType<typeof createFixture>>;
const createFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "intentarc preflight envelope "));
  const paths = {
    manifest: join(root, "authorization manifest.json"), envelope: join(root, "desktop release preflight once.ps1"),
    controller: join(root, "desktop release preflight out preservation.ps1"), git: join(root, "git fixture.exe"),
    node: join(root, "node fixture.exe"), cmd: join(root, "cmd fixture.exe"), pnpm: join(root, "pnpm fixture.exe"),
    host: join(root, "powershell fixture.exe"),
  };
  for (const [name, path] of Object.entries(paths)) if (name !== "manifest") await writeFile(path, `fixture:${name}:${path}`, "utf8");
  const document = {
    schema: "intentarc.preflight-execution-authorization/v1", attemptId: "phase1-preflight-envelope-20260902-01",
    controllerRunId: "phase1-preflight-20260901-06", jobName: "IntentArc.Preflight.phase1-preflight-20260901-06",
    canonicalPath: root, branch: "master", expectedCommit: "0123456789abcdef0123456789abcdef01234567",
    authorizationManifestPath: paths.manifest, envelopePath: paths.envelope, envelopeSha256: sha256(await readFile(paths.envelope)),
    controllerPath: paths.controller, controllerSha256: sha256(await readFile(paths.controller)),
    gitPath: paths.git, gitSha256: sha256(await readFile(paths.git)), nodePath: paths.node, nodeSha256: sha256(await readFile(paths.node)),
    cmdPath: paths.cmd, cmdSha256: sha256(await readFile(paths.cmd)), pnpmPath: paths.pnpm, pnpmSha256: sha256(await readFile(paths.pnpm)),
    outerPowerShellPath: paths.host, outerPowerShellSha256: sha256(await readFile(paths.host)),
    maximumControllerStdoutBytes: 1048576, maximumControllerStderrBytes: 1048576, maximumAttempts: 1,
    retryAuthorized: false, restoreOnlyAuthorized: false, signedReleaseAuthorized: false, createdAtUtc: "2026-09-02T00:00:00.000Z",
  };
  expect(Object.keys(document)).toEqual(authorizationKeys);
  await writeFile(paths.manifest, JSON.stringify(document), "utf8");
  return { root, paths, document };
};
const disposeFixture = (fixture: Fixture) => rm(fixture.root, { recursive: true, force: true });
const snapshotFixture = async (fixture: Fixture) => {
  const snapshot: Record<string, string> = {};
  for (const [name, path] of Object.entries(fixture.paths)) snapshot[name] = sha256(await readFile(path));
  return snapshot;
};
const bindingsExpression = (fixture: Fixture) => {
  const bindings = Object.entries(fixture.paths).filter(([name]) => name !== "manifest").map(([name, path]) => `${name}=${quote(path)}`).join(";");
  return `@{${bindings}}`;
};
const contractExpression = (fixture: Fixture) => `New-IntentArcPreflightEnvelopeTestContract -Root ${quote(fixture.root)} -ExecutableBindings ${bindingsExpression(fixture)}`;
const reviewedHostText = (fixture: Fixture, mode: "Execute" | "AuditOnly", hash: string) =>
  `"${fixture.paths.host}" -NoProfile -NonInteractive -File "${fixture.paths.envelope}" -${mode} -AuthorizationManifest "${fixture.paths.manifest}" -ExpectedAuthorizationSha256 ${hash}`;

type ValidationOptions = {
  expectedSha256?: string; rawHostCommandLine?: string; metadataHostPath?: string; metadataEnvelopePath?: string | null;
  manifestInitialFault?: string; manifestPostReadFault?: string;
  boundFault?: { name: (typeof boundNames)[number]; phase: "initial" | "post"; fault: string };
};
const validateManifestBytes = async (fixture: Fixture, mode: "Execute" | "AuditOnly", bytes: Buffer, options: ValidationOptions = {}) => {
  await writeFile(fixture.paths.manifest, bytes);
  const expectedHash = options.expectedSha256 ?? sha256(bytes);
  const metadataEnvelope = options.metadataEnvelopePath === null ? "$null" : quote(options.metadataEnvelopePath ?? fixture.paths.envelope);
  const body = [
    `. ${quote(scriptPath)}`, `$contract = ${contractExpression(fixture)}`,
    "$hooks = if ($null -ne $contract.PSObject.Properties['TestHooks']) { $contract.TestHooks } else { $null }",
    options.manifestInitialFault ? `if ($null -ne $hooks) { $hooks.ManifestInitialObservationFault = ${quote(options.manifestInitialFault)} }` : "",
    options.manifestPostReadFault ? `if ($null -ne $hooks) { $hooks.ManifestPostReadObservationFault = ${quote(options.manifestPostReadFault)} }` : "",
    options.boundFault ? `if ($null -ne $hooks) { $hooks.Bound${options.boundFault.phase === "initial" ? "Initial" : "PostRead"}FaultName = ${quote(options.boundFault.name)}; $hooks.Bound${options.boundFault.phase === "initial" ? "Initial" : "PostRead"}ObservationFault = ${quote(options.boundFault.fault)} }` : "",
    `$invocation = [pscustomobject]@{ mode=${quote(mode)}; manifestPath=${quote(fixture.paths.manifest)}; expectedSha256=${quote(expectedHash)}; InvocationMetadata=[pscustomobject]@{ HostImagePath=${quote(options.metadataHostPath ?? fixture.paths.host)}; RawCommandLine=${quote(options.rawHostCommandLine ?? reviewedHostText(fixture, mode, expectedHash))}; EnvelopePath=${metadataEnvelope} } }`,
    "$context = $null", "$answer = $null", "try {",
    `  $context = Read-IntentArcPreflightExecutionAuthorizationManifest -LiteralPath ${quote(fixture.paths.manifest)} -ExpectedSha256 ${quote(expectedHash)} -ActualInvocation $invocation -Contract $contract`,
    "  $answer = [ordered]@{ ok=$true; mode=$context.Invocation.mode; exactBytes=$context.ExactBytes.Length; contextType=$context.GetType().FullName; guardType=$context.ManifestGuard.GetType().FullName; expectedFinalPath=$context.ManifestGuard.ExpectedFinalPath; manifestOpens=if ($null -eq $hooks) {-1} else {$hooks.ManifestOpenCount}; boundOpens=if ($null -eq $hooks) {-1} else {$hooks.BoundOpenCount}; faultApplications=if ($null -eq $hooks) {-1} else {$hooks.FaultApplications} }",
    "} catch { $answer = [ordered]@{ ok=$false; category='authorization-invalid'; manifestOpens=if ($null -eq $hooks) {-1} else {$hooks.ManifestOpenCount}; boundOpens=if ($null -eq $hooks) {-1} else {$hooks.BoundOpenCount}; faultApplications=if ($null -eq $hooks) {-1} else {$hooks.FaultApplications} } }",
    "finally { if ($null -ne $context) { $context.Dispose() } }", "$answer | ConvertTo-Json -Compress -Depth 8",
  ].filter(Boolean).join("\n");
  return JSON.parse(await runPowerShell(body)) as Record<string, unknown>;
};
const validateManifest = (fixture: Fixture, mode: "Execute" | "AuditOnly", document: Record<string, unknown> = fixture.document, options: ValidationOptions = {}) =>
  validateManifestBytes(fixture, mode, Buffer.from(JSON.stringify(document)), options);
const parsePublicVector = async (tokens: readonly string[]) => {
  const body = `. ${quote(scriptPath)}; $metadata=[pscustomobject]@{HostImagePath='host';RawCommandLine='raw';EnvelopePath='script'}; $value=Test-IntentArcPreflightOnceInvocation -RawArguments @(${tokens.map(quote).join(",")}) -InvocationMetadata $metadata; if ($null -eq $value) {[ordered]@{ok=$false;category='authorization-invalid'}|ConvertTo-Json -Compress} else {[ordered]@{ok=$true;mode=$value.mode;manifestPath=$value.manifestPath;expectedSha256=$value.expectedSha256}|ConvertTo-Json -Compress}`;
  return JSON.parse(await runPowerShell(body)) as Record<string, unknown>;
};
const runReviewedDirect = (tokens: readonly string[], directScriptPath: string, env?: NodeJS.ProcessEnv, outerHostArguments: readonly string[] = ["-NoProfile", "-NonInteractive", "-File"]) => new Promise<ProcessOutcome>((resolve) => {
  const quoteWindows = (value: string) => `"${value.replaceAll('"', '\\"')}"`;
  const arguments_ = [...outerHostArguments, quoteWindows(directScriptPath), ...tokens.map((token) => /\s/.test(token) ? quoteWindows(token) : token)];
  const child = spawn(powerShell, arguments_, { argv0: quoteWindows(powerShell), env, windowsHide: true, windowsVerbatimArguments: true });
  let stdout = ""; let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); }); child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  child.on("error", (error) => resolve({ exitCode: 1, stdout, stderr: stderr + error.message }));
  child.on("close", (exitCode) => resolve({ exitCode: exitCode ?? 1, stdout, stderr }));
});
const expectClosedDirectRefusal = (outcome: ProcessOutcome) => {
  expect(outcome.exitCode).toBe(1); expect(outcome.stderr).toBe("");
  expect(outcome.stdout).toBe(`${JSON.stringify(expectedRefusal)}\r\n`);
  const value = JSON.parse(outcome.stdout.trimEnd()) as Record<string, unknown>;
  expect(Object.keys(value)).toEqual(auditKeys); expect(value).toEqual(expectedRefusal); expect(outcome.stdout).not.toContain("sensitive-");
};
const validPublicTokens = (mode: "Execute" | "AuditOnly" = "Execute") => [`-${mode}`, "-AuthorizationManifest", productionManifestPath, "-ExpectedAuthorizationSha256", "0".repeat(64)] as const;

const runBoundaryHarness = async (body: string, reviewedScriptPath = scriptPath) => JSON.parse(await runPowerShell([
  `. ${quote(reviewedScriptPath)}`,
  "Initialize-IntentArcPreflightExecutionNative",
  body,
].join("\n"))) as Record<string, unknown>;

const immutableEvidenceViolations = (source: string) => {
  const violations: string[] = [];
  const checks: Array<[string, RegExp]> = [
    ["replacement method", /\bReplaceAtomicMonotonic\s*\(/],
    ["replacement flag", /\b(?:ReplaceIfExists|MoveFileReplaceExisting|FileRenameReplaceIfExists|FileRenamePosixSemantics)\b|MOVEFILE_REPLACE_EXISTING|FILE_RENAME_REPLACE_IF_EXISTS|FILE_RENAME_POSIX_SEMANTICS|Marshal\.WriteByte\(information,\s*0,\s*1\)/i],
    ["destination deletion", /DeleteBoundIdentity\s*\(\s*(?:prior|destination|existing|admitted)Guard\s*\)/],
    ["truncation", /\b(?:SetEndOfFile|SetLength|FileMode\.Truncate|CreateAlways|TruncateExisting)\b|\bCREATE_ALWAYS\b|\bTRUNCATE_EXISTING\b/i],
    ["in-place evidence rewrite", /OpenFileForMutation\([^\n]*\)[\s\S]{0,600}?\.WriteAndFlush\s*\(/],
    ["transactional or POSIX replacement", /\b(?:CreateTransaction|CommitTransaction|MoveFileTransacted|FileRenameInformationEx)\b/],
  ];
  for (const [name, pattern] of checks) if (pattern.test(source)) violations.push(name);
  const writeCalls = source.match(/\.WriteAndFlush\s*\(/g)?.length ?? 0;
  if (writeCalls !== 1) violations.push("non-exclusive write path");
  return violations;
};

const durableBoundaryViolations = (source: string) => {
  const violations: string[] = [];
  if (!source.includes("internal static extern int NtCreateFile")) violations.push("missing relative create primitive");
  if (!/FileWriteThrough\s*=\s*0x00000002u/.test(source) || !/uint options = FileWriteThrough \|/.test(source)) violations.push("missing write-through create");
  if (source.includes("Native.CreateDirectory(")) violations.push("absolute directory create");
  if (!source.includes("root = BoundaryGuard.CreateDirectoryRelative(parent, leaf, rootPath, descriptor);")) violations.push("unanchored root create");
  if (!source.includes("guard = BoundaryGuard.CreateFileRelative(root, leaf, path, descriptor);")) violations.push("unanchored temporary create");
  if (!source.includes("createDirectory ? ShareRead | ShareWrite : ShareRead, FileCreate, options, IntPtr.Zero, 0u);")) violations.push("relative file create shares write");
  if (!source.includes("MarkDelete(createdLeaf.DangerousGetHandle())")) violations.push("unbound constructor cleanup");
  if ((source.match(/\bFlushDurable\(\);/g)?.length ?? 0) !== 7) violations.push("incomplete durable flush protocol");
  const nativeBody = source.match(/public static class Native \{([\s\S]*?)\n  \}/)?.[1] ?? "";
  const publicNativeMethods = [...nativeBody.matchAll(/public static extern \w+\s+(\w+)\(/g)].map((match) => match[1]).sort();
  if (JSON.stringify(publicNativeMethods) !== JSON.stringify(["CommandLineToArgvW", "GetCommandLineW", "LocalFree", "QueryFullProcessImageNameW"].sort())) violations.push("public raw native mutator");
  return violations;
};

const task4ProcessViolations = (source: string) => {
  const violations: string[] = [];
  const requireText = (name: string, text: string) => { if (!source.includes(text)) violations.push(name); };
  const requireCount = (name: string, pattern: RegExp, count: number) => {
    if ((source.match(pattern)?.length ?? 0) !== count) violations.push(name);
  };
  if (!/public enum ProcessRole \{ GitObservation, Controller \}/.test(source)) violations.push("closed process roles");
  requireCount("dispatcher Run cardinality", /public static NativeProcessLaunchResult Run\(/g, 1);
  requireCount("sole process creation", /\bprocess\.Start\(\)/g, 1);
  requireCount("closed non-creation proofs", /return new NativeProcessLaunchResult\(false, true, null, false, false, "launch-failed"\);/g, 2);
  requireText("start exception remains uncertain", 'throw new InvalidOperationException("process-launch-uncertain");');
  if (/Start-Process|\[Diagnostics\.Process\]::Start|Process\.Start\(/.test(source)) violations.push("alternate process creation");
  requireText("async stream drain", "return Task.Run(() => {");
  requireText("concurrent stdout drain", "stdoutTask = DrainAsync(process.StandardOutput.BaseStream, true, false, false);");
  requireText("concurrent stderr drain", 'stderrTask = DrainAsync(process.StandardError.BaseStream, false, setupFault == "stderr-mid-drain-failure",');
  requireText("complete byte hashing", "algorithm.TransformBlock(buffer, 0, read, buffer, 0);");
  requireText("exact retention bound", "int available = checked(MaximumCaptureBytes - (int)kept.Length);");
  requireCount("exact overflow comparison", /Overflow = count > MaximumCaptureBytes/g, 2);
  requireText("continue to EOF", "if (read == 0) break;");
  requireText("byte-exact stdout return", "stdout = stdoutCapture.Retained;");
  if (/ReadToEnd|ReadLine|StreamReader/.test(source)) violations.push("text stream capture");
  requireText("closed environment clearing", "$StartInfo.EnvironmentVariables.Clear()");
  requireText("exact controller host", 'String.Equals(info.FileName, "C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe", StringComparison.Ordinal)');
  requireText("exact working directory", "$info.WorkingDirectory = $WorkingDirectory");
  requireText("execute-only controller", "'-Execute', '-ExpectedCommit'");
  requireText("controller shell disabled", "$info.UseShellExecute = $false");
  requireText("stdout redirected", "$info.RedirectStandardOutput = $true");
  requireText("stderr redirected", "$info.RedirectStandardError = $true");
  requireText("hidden controller", "$info.CreateNoWindow = $true");
  requireText("controller cardinality", "controllerGate == null || !controllerGate.TryConsume()");
  requireText("mandatory pinned bindings", "ValidateStartInfo(role, startInfo, bindings);");
  requireText("pinned expected commit", "!String.Equals(arguments[6], bindings.ExpectedCommit, StringComparison.Ordinal)");
  requireText("pinned pnpm SHA", "!String.Equals(arguments[10], bindings.PnpmSha256, StringComparison.Ordinal)");
  requireText("pre-wait partial drain rejection", "if (supervisor.StdoutTask == null || supervisor.StderrTask == null) throw new InvalidOperationException(\"capture-invalid\");");
  requireCount("settlement state separate from receive attempt", /!supervisor\.SettlementComplete/g, 2);
  requireText("available partial capture", "public static NativeProcessCaptureResult GetAvailableCapture(NativeProcessSupervisor supervisor)");
  requireText("Git has no controller gate", "else if (controllerGate != null) throw new InvalidOperationException(\"git-role-invalid\")");
  requireText("stderr never retained", 'stderrTask = DrainAsync(process.StandardError.BaseStream, false, setupFault == "stderr-mid-drain-failure",');
  if (/public byte\[\] stderr\b|stderr\s*=\s*stderrCapture\.Retained/.test(source)) violations.push("stderr text exposure");
  for (const vector of [
    'bool root = arguments.Length == 7 && arguments[5] == "rev-parse" && arguments[6] == "--show-toplevel";',
    'bool branch = arguments.Length == 9 && arguments[5] == "symbolic-ref" && arguments[6] == "--quiet" && arguments[7] == "--short" && arguments[8] == "HEAD";',
    'bool head = arguments.Length == 8 && arguments[5] == "rev-parse" && arguments[6] == "--verify" && arguments[7] == "HEAD";',
    'bool status = arguments.Length == 8 && arguments[5] == "status" && arguments[6] == "--porcelain=v1" && arguments[7] == "--untracked-files=no";',
  ]) requireText("exact Git vectors", vector);
  return [...new Set(violations)].sort();
};

type ExecuteHarnessOptions = {
  host?: boolean;
  hostStoredAudit?: boolean | "malformed" | "mismatch";
  faultAfter?: string;
  start?: {
    processCreated: boolean;
    nonCreationProven: boolean;
    supervisor: { processId: number; startTimeUtc: string } | null;
    supervisorIdentityValid: boolean;
    drainsInitialized: boolean;
    setupCategory: string;
  };
  throwAt?: string;
  collisionAt?: "consumption" | "controller-started";
  replay?: boolean;
  scriptPath?: string;
  journalMutationProbe?: boolean;
  resultOverride?: { operation: string; expression: string };
  countedOutGuard?: boolean;
  manualOutGuardCleanup?: boolean;
};

const runExecuteHarness = async (fixture: Fixture, options: ExecuteHarnessOptions = {}) => {
  const hostEvidence = options.host ? task6SuccessEvidence() : null;
  if (hostEvidence && options.hostStoredAudit) {
    hostEvidence.storedAuditDisposition = "present";
    hostEvidence.storedAuditDocument = { ...task5Audit(), expectedCommit: fixture.document.expectedCommit };
    if (options.hostStoredAudit === "malformed") hostEvidence.storedAuditDocument = {};
    if (options.hostStoredAudit === "mismatch") hostEvidence.storedAuditDocument.expectedCommit = "f".repeat(40);
    hostEvidence.storedAuditBytesBase64 = Buffer.from(JSON.stringify(hostEvidence.storedAuditDocument)).toString("base64");
  }
  const envelopeParent = join(fixture.root, ".superpowers", "preflight-execution-envelope");
  const outPath = join(fixture.root, "out");
  await mkdir(envelopeParent, { recursive: true });
  await mkdir(outPath, { recursive: true });
  const bytes = Buffer.from(JSON.stringify(fixture.document));
  await writeFile(fixture.paths.manifest, bytes);
  const expectedHash = sha256(bytes);
  const start = options.start ?? {
    processCreated: true, nonCreationProven: false,
    supervisor: { processId: 4242, startTimeUtc: "2026-09-02T00:00:01.000Z" },
    supervisorIdentityValid: true, drainsInitialized: true, setupCategory: "none",
  };
  const supervisor = start.supervisor === null
    ? "$null"
    : `[pscustomobject][ordered]@{processId=${start.supervisor.processId};startTimeUtc=${quote(start.supervisor.startTimeUtc)}}`;
  const operationResult = (operation: string, expression: string) =>
    options.resultOverride?.operation === operation ? options.resultOverride.expression : expression;
  const injectedThrow = (name: string) => options.throwAt === name
    ? name === "StartController" ? "throw [OperationCanceledException]::new('fixture-cancellation')" : `throw [InvalidOperationException]::new(${quote(`fixture-${name}`)})`
    : "";
  const consumedPath = join(envelopeParent, "phase1-preflight-envelope-20260902-01", "consumed.json");
  const startedPath = join(envelopeParent, "phase1-preflight-envelope-20260902-01", "controller-started.json");
  const mutationProbe = (path: string, stateName: string) => options.journalMutationProbe
    ? `try{$writer=[IO.File]::Open(${quote(path)},[IO.FileMode]::Open,[IO.FileAccess]::Write,[IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete);try{$writer.SetLength(2);$writer.Write([byte[]](123,125),0,2);$writer.Flush($true);$state.${stateName}=$true}finally{$writer.Dispose()}}catch{}`
    : "";
  const releasedProbe = (path: string, stateName: string) => options.journalMutationProbe
    ? `try{$writer=[IO.File]::Open(${quote(path)},[IO.FileMode]::Open,[IO.FileAccess]::Write,[IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete);$writer.Dispose();$state.${stateName}=$true}catch{}`
    : "";
  const body = [
    `. ${quote(options.scriptPath ?? scriptPath)}`,
    options.countedOutGuard ? "Add-Type -TypeDefinition 'using System;namespace IntentArc.Task3Fixture{public sealed class CountedDisposable:IDisposable{public int DisposeCount{get;private set;}public void Dispose(){DisposeCount++;}}}'" : "",
    `$contract=${contractExpression(fixture)}`,
    `$invocation=[pscustomobject]@{mode='Execute';manifestPath=${quote(fixture.paths.manifest)};expectedSha256=${quote(expectedHash)};InvocationMetadata=[pscustomobject]@{HostImagePath=${quote(fixture.paths.host)};RawCommandLine=${quote(reviewedHostText(fixture, "Execute", expectedHash))};EnvelopePath=${quote(fixture.paths.envelope)}}}`,
    `$context=Read-IntentArcPreflightExecutionAuthorizationManifest -LiteralPath ${quote(fixture.paths.manifest)} -ExpectedSha256 ${quote(expectedHash)} -ActualInvocation $invocation -Contract $contract`,
    "$events=[Collections.Generic.List[string]]::new();$state=[pscustomobject]@{starts=0;finalizations=0;startedWrites=0;auditWrites=0;rootGuard=$null;outGuard=$null;outRenameSucceeded=$false;consumedWriterOpened=$false;startedWriterOpened=$false;postExecuteConsumedWriterOpened=$false;postExecuteStartedWriterOpened=$false};$errors=[Collections.Generic.List[string]]::new()",
    "$observer={param($name)[void]$events.Add([string]$name)}",
    "$handlers=[ordered]@{",
    `BindExecutionInputs={param($document)${injectedThrow("BindExecutionInputs")};${operationResult("BindExecutionInputs", "[pscustomobject][ordered]@{valid=$true}")}}`,
    `GetRepositoryState={param($document)${injectedThrow("GetRepositoryState")};${operationResult("GetRepositoryState", "[pscustomobject][ordered]@{valid=$true}")}}`,
    `GuardBoundaries={param($document)${injectedThrow("GuardBoundaries")};$state.outGuard=${options.countedOutGuard ? "[IntentArc.Task3Fixture.CountedDisposable]::new()" : `[IntentArc.PreflightEnvelope.BoundaryGuard]::OpenDirectory(${quote(outPath)},${quote(outPath)})`};${operationResult("GuardBoundaries", "[pscustomobject][ordered]@{valid=$true;outGuard=$state.outGuard}")}}`,
    `ProbeId06Unused={param($document)${injectedThrow("ProbeId06Unused")};${operationResult("ProbeId06Unused", "[pscustomobject][ordered]@{unused=$true}")}}`,
    `CreateAttemptRoot={param($document)${injectedThrow("CreateAttemptRoot")};$state.rootGuard=New-IntentArcPreflightEnvelopeAttemptRoot -AuthorizationContext $context;${operationResult("CreateAttemptRoot", "[pscustomobject][ordered]@{created=$true}")}}`,
    `CopyAuthorization={param($document)${injectedThrow("CopyAuthorization")};$actual=Copy-IntentArcPreflightEnvelopeAuthorization -AuthorizationContext $context -RootGuard $state.rootGuard;${operationResult("CopyAuthorization", "$actual")}}`,
    `WriteConsumptionAttempted={param($document)${injectedThrow("WriteConsumptionAttempted")};if(${options.collisionAt === "consumption" ? "$true" : "$false"}){$collision=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::WriteAtomicNew($state.rootGuard,'consumed.json',[Text.Encoding]::UTF8.GetBytes('{}'));$collision.Dispose()};$actual=Write-IntentArcPreflightEnvelopeConsumptionAttempted -AuthorizationContext $context -RootGuard $state.rootGuard;${operationResult("WriteConsumptionAttempted", "$actual")}}`,
    `StartController={param($document)$state.starts++;${mutationProbe(consumedPath, "consumedWriterOpened")}${injectedThrow("StartController")};$moved=${quote(outPath + " moved")};try{[IO.Directory]::Move(${quote(outPath)},$moved);[IO.Directory]::Move($moved,${quote(outPath)});$state.outRenameSucceeded=$true}catch{};${operationResult("StartController", `[pscustomobject][ordered]@{processCreated=$${start.processCreated};nonCreationProven=$${start.nonCreationProven};supervisor=${supervisor};supervisorIdentityValid=$${start.supervisorIdentityValid};drainsInitialized=$${start.drainsInitialized};setupCategory=${quote(start.setupCategory)}}`)}}`,
    `WriteControllerStarted={param($document,$consumedSha256,$processId,$startTimeUtc)$state.startedWrites++;${injectedThrow("WriteControllerStarted")};if(${options.collisionAt === "controller-started" ? "$true" : "$false"}){$collision=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::WriteAtomicNew($state.rootGuard,'controller-started.json',[Text.Encoding]::UTF8.GetBytes('{}'));$collision.Dispose()};$actual=Write-IntentArcPreflightEnvelopeControllerStarted -AuthorizationContext $context -RootGuard $state.rootGuard -ConsumedSha256 $consumedSha256 -ProcessId $processId -StartTimeUtc $startTimeUtc;${operationResult("WriteControllerStarted", "$actual")}}`,
    `FinalizeControllerAttempt={param($document,$launch,$controllerStartedValid)$state.finalizations++;${mutationProbe(startedPath, "startedWriterOpened")}${injectedThrow("FinalizeControllerAttempt")};${operationResult("FinalizeControllerAttempt", "[pscustomobject][ordered]@{finalized=$true}")}}`,
    "}",
    `$operations=New-IntentArcPreflightEnvelopeOperations -Handlers $handlers -Observer $observer${options.faultAfter ? ` -FaultAfterOperation ${quote(options.faultAfter)}` : ""}`,
    options.host ? "$operations | Add-Member -MemberType ScriptMethod -Name OwnsAttemptRoot -Value { $null -ne $state.rootGuard }" : "",
    options.host ? `$auditEvidence=${task5PowerShellJson(hostEvidence)};$auditHandlers=[ordered]@{ReadAuditEvidence={$auditEvidence};ObserveGit={param($d,$name)$text=switch($name){root{$d.canonicalPath+"\n"};branch{"master\n"};head{$d.expectedCommit+"\n"};status{""}};[pscustomobject][ordered]@{exitCode=0;stderrBytes=0;overflow=$false;stdout=$text}};WriteAuditResult={param($d,$bytes)$state.auditWrites++;[void](Write-IntentArcPreflightEnvelopeImmutableBytes -RootGuard $state.rootGuard -Leaf 'audit-result.json' -Bytes $bytes -MaximumBytes 16384);[pscustomobject][ordered]@{written=$true}}};$auditOperations=New-IntentArcPreflightTerminalAuditOperations -Handlers $auditHandlers;$first=Invoke-IntentArcPreflightEnvelopeHost -Invocation $invocation -Contract $contract -Operations ([pscustomobject]@{Execute=$operations;Audit=$auditOperations})` : "$first=$null;try{$first=Invoke-IntentArcPreflightEnvelopeExecute -AuthorizationContext $context -Operations $operations}catch{[void]$errors.Add(($events -join ',')+':'+$_.Exception.Message)}",
    releasedProbe(consumedPath, "postExecuteConsumedWriterOpened"),
    releasedProbe(startedPath, "postExecuteStartedWriterOpened"),
    options.replay
      ? "$secondRoot=$state.rootGuard;$state.rootGuard=$null;$secondOperations=New-IntentArcPreflightEnvelopeOperations -Handlers $handlers -Observer $observer;try{[void](Invoke-IntentArcPreflightEnvelopeExecute -AuthorizationContext $context -Operations $secondOperations)}catch{[void]$errors.Add(($events -join ',')+':'+$_.Exception.Message)};if($null-ne$state.rootGuard){$state.rootGuard.Dispose()};$state.rootGuard=$secondRoot"
      : "",
    "$rootExists=[IntentArc.PreflightEnvelope.EntryProbe]::Probe((Join-Path " + quote(envelopeParent) + " 'phase1-preflight-envelope-20260902-01')).ToString()",
    "$answer=[ordered]@{operations=@($events);auditWrites=$state.auditWrites;controllerStarts=$state.starts;finalizations=$state.finalizations;controllerStartedWrites=$state.startedWrites;outRenameSucceeded=$state.outRenameSucceeded;consumedWriterOpened=$state.consumedWriterOpened;startedWriterOpened=$state.startedWriterOpened;postExecuteConsumedWriterOpened=$state.postExecuteConsumedWriterOpened;postExecuteStartedWriterOpened=$state.postExecuteStartedWriterOpened;outGuardDisposeCount=if($null-ne$state.outGuard-and$null-ne$state.outGuard.PSObject.Properties['DisposeCount']){$state.outGuard.DisposeCount}else{$null};rootExists=$rootExists;errors=@($errors);result=$first}",
    `if($null-ne$state.rootGuard){$state.rootGuard.Dispose()};if($null-ne$state.outGuard-and$${options.manualOutGuardCleanup !== false}){$state.outGuard.Dispose()};$context.Dispose();$answer|ConvertTo-Json -Compress -Depth 12`,
  ].filter(Boolean).join("\n");
  return JSON.parse(await runPowerShell(body)) as {
    operations: string[]; auditWrites: number; controllerStarts: number; finalizations: number; controllerStartedWrites: number;
    outRenameSucceeded: boolean; consumedWriterOpened: boolean; startedWriterOpened: boolean;
    postExecuteConsumedWriterOpened: boolean; postExecuteStartedWriterOpened: boolean;
    outGuardDisposeCount: number | null;
    rootExists: string; errors: string[]; result: Record<string, unknown> | null;
  };
};

const task3AstViolations = async (candidatePath: string) => {
  const result = JSON.parse(await runPowerShellScript(`. ${quote(scriptPath)}\nTest-IntentArcPreflightEnvelopeSourcePolicy -SourceText (Get-Content -LiteralPath ${quote(candidatePath)} -Raw) | ConvertTo-Json -Compress`)) as { valid: boolean; categories: string[] };
  return result.categories;
};

type JournalFaultStage = "write" | "protection" | "temporary-flush" | "post-promotion-flush" | "reopen";
const writeTask3JournalFaultScript = async (fixture: Fixture, journal: "consumed" | "controller-started", stage: JournalFaultStage) => {
  const source = await readFile(scriptPath, "utf8");
  const temporaryMatch = `.${journal}.json.`;
  const destinationMatch = `\\${journal}.json`;
  const temporaryFault = `        if (path.IndexOf(${JSON.stringify(temporaryMatch)}, StringComparison.OrdinalIgnoreCase) >= 0) { throw new InvalidOperationException(${JSON.stringify(`fixture-${stage}`)}); }`;
  const destinationFault = `        if (destination.EndsWith(${JSON.stringify(destinationMatch)}, StringComparison.OrdinalIgnoreCase)) { throw new InvalidOperationException(${JSON.stringify(`fixture-${stage}`)}); }`;
  const replacements: Record<JournalFaultStage, [string, string]> = {
    write: ["        guard.WriteAndFlush(bytes);", `        guard.WriteAndFlush(bytes);\n${temporaryFault}`],
    protection: ["        ApplyProtection(guard.LeafHandle, false);", `        ApplyProtection(guard.LeafHandle, false);\n${temporaryFault}`],
    "temporary-flush": ["        guard.FlushDurable();\n        byte[] actual = guard.ReadAllBytes", `        guard.FlushDurable();\n${temporaryFault}\n        byte[] actual = guard.ReadAllBytes`],
    "post-promotion-flush": ["        temporaryGuard.FlushDurable();\n        root.FlushDurable();", `        temporaryGuard.FlushDurable();\n${destinationFault}\n        root.FlushDurable();`],
    reopen: ["        try {\n          byte[] reopened = verification.ReadAllBytes", `        try {\n${destinationFault}\n          byte[] reopened = verification.ReadAllBytes`],
  };
  const [needle, replacement] = replacements[stage];
  const faulted = source.replace(needle, replacement);
  expect(faulted).not.toBe(source);
  const path = join(fixture.root, `${journal}-${stage}-fault.ps1`);
  await writeFile(path, faulted, "utf8");
  return path;
};

describe.sequential("desktop release preflight once public vector and authorization manifest", () => {
  it("accepts only the exact Execute and AuditOnly public vectors", async () => {
    expect(await parsePublicVector(validPublicTokens("Execute"))).toEqual({ ok: true, mode: "Execute", manifestPath: productionManifestPath, expectedSha256: "0".repeat(64) });
    expect(await parsePublicVector(validPublicTokens("AuditOnly"))).toEqual({ ok: true, mode: "AuditOnly", manifestPath: productionManifestPath, expectedSha256: "0".repeat(64) });
  });

  const publicVectorMutations: Array<[string, readonly string[]]> = [
    ["missing mode", ["-AuthorizationManifest", productionManifestPath, "-ExpectedAuthorizationSha256", "0".repeat(64)]],
    ["missing authorization flag", ["-Execute", productionManifestPath, "-ExpectedAuthorizationSha256", "0".repeat(64)]],
    ["missing expected-hash flag", ["-Execute", "-AuthorizationManifest", productionManifestPath, "0".repeat(64)]],
    ["reordered mode", ["-AuthorizationManifest", productionManifestPath, "-ExpectedAuthorizationSha256", "0".repeat(64), "-Execute"]],
    ["reordered authorization flag", ["-Execute", "-ExpectedAuthorizationSha256", productionManifestPath, "-AuthorizationManifest", "0".repeat(64)]],
    ["reordered expected-hash flag", ["-Execute", "-ExpectedAuthorizationSha256", "0".repeat(64), "-AuthorizationManifest", productionManifestPath]],
    ["duplicated mode", ["-Execute", "-Execute", "-AuthorizationManifest", productionManifestPath, "-ExpectedAuthorizationSha256", "0".repeat(64)]],
    ["duplicated authorization flag", ["-Execute", "-AuthorizationManifest", "-AuthorizationManifest", productionManifestPath, "-ExpectedAuthorizationSha256", "0".repeat(64)]],
    ["duplicated expected-hash flag", ["-Execute", "-AuthorizationManifest", productionManifestPath, "-ExpectedAuthorizationSha256", "-ExpectedAuthorizationSha256", "0".repeat(64)]],
    ["case-drifted mode", ["-execute", "-AuthorizationManifest", productionManifestPath, "-ExpectedAuthorizationSha256", "0".repeat(64)]],
    ["forbidden RestoreOnly mode", ["-RestoreOnly", "-AuthorizationManifest", productionManifestPath, "-ExpectedAuthorizationSha256", "0".repeat(64)]],
    ["case-drifted authorization flag", ["-Execute", "-authorizationManifest", productionManifestPath, "-ExpectedAuthorizationSha256", "0".repeat(64)]],
    ["case-drifted expected-hash flag", ["-Execute", "-AuthorizationManifest", productionManifestPath, "-expectedAuthorizationSha256", "0".repeat(64)]],
    ["abbreviated mode", ["-Ex", "-AuthorizationManifest", productionManifestPath, "-ExpectedAuthorizationSha256", "0".repeat(64)]],
    ["abbreviated authorization flag", ["-Execute", "-AuthorizationM", productionManifestPath, "-ExpectedAuthorizationSha256", "0".repeat(64)]],
    ["abbreviated expected-hash flag", ["-Execute", "-AuthorizationManifest", productionManifestPath, "-ExpectedAuthorizationS", "0".repeat(64)]],
    ["common parameter", [...validPublicTokens(), "-Verbose"]],
    ["relative manifest", ["-Execute", "-AuthorizationManifest", ".\\authorization.json", "-ExpectedAuthorizationSha256", "0".repeat(64)]],
    ["wrong fixed manifest", ["-Execute", "-AuthorizationManifest", "C:\\wrong.json", "-ExpectedAuthorizationSha256", "0".repeat(64)]],
    ["uppercase hash", ["-Execute", "-AuthorizationManifest", productionManifestPath, "-ExpectedAuthorizationSha256", "A".repeat(64)]],
    ["short hash", ["-Execute", "-AuthorizationManifest", productionManifestPath, "-ExpectedAuthorizationSha256", "0".repeat(63)]],
    ["nonhex hash", ["-Execute", "-AuthorizationManifest", productionManifestPath, "-ExpectedAuthorizationSha256", "g".repeat(64)]],
  ];
  it.each(publicVectorMutations)("refuses public-vector mutation %s", async (_name, tokens) => {
    expect(await parsePublicVector(tokens)).toEqual({ ok: false, category: "authorization-invalid" });
  });

  it("admits both exact reviewed outer-host texts and records pinned opens", async () => {
    const fixture = await createFixture();
    try {
      for (const mode of ["Execute", "AuditOnly"] as const) expect(await validateManifest(fixture, mode)).toMatchObject({ ok: true, mode, manifestOpens: 1, boundOpens: 7 });
    } finally { await disposeFixture(fixture); }
  });

  const outerHostMutations: Array<[string, (fixture: Fixture, hash: string) => ValidationOptions]> = [
    ["missing NoProfile", (f, h) => ({ rawHostCommandLine: reviewedHostText(f, "Execute", h).replace(" -NoProfile", "") })],
    ["missing NonInteractive", (f, h) => ({ rawHostCommandLine: reviewedHostText(f, "Execute", h).replace(" -NonInteractive", "") })],
    ["missing File", (f, h) => ({ rawHostCommandLine: reviewedHostText(f, "Execute", h).replace(" -File", "") })],
    ["reordered NoProfile", (f, h) => ({ rawHostCommandLine: reviewedHostText(f, "Execute", h).replace("-NoProfile -NonInteractive", "-NonInteractive -NoProfile") })],
    ["reordered NonInteractive", (f, h) => ({ rawHostCommandLine: reviewedHostText(f, "Execute", h).replace("-NonInteractive -File", "-File -NonInteractive") })],
    ["reordered File", (f, h) => ({ rawHostCommandLine: reviewedHostText(f, "Execute", h).replace("-NoProfile -NonInteractive -File", "-File -NoProfile -NonInteractive") })],
    ["duplicated NoProfile", (f, h) => ({ rawHostCommandLine: reviewedHostText(f, "Execute", h).replace("-NoProfile", "-NoProfile -NoProfile") })],
    ["duplicated NonInteractive", (f, h) => ({ rawHostCommandLine: reviewedHostText(f, "Execute", h).replace("-NonInteractive", "-NonInteractive -NonInteractive") })],
    ["duplicated File", (f, h) => ({ rawHostCommandLine: reviewedHostText(f, "Execute", h).replace("-File", "-File -File") })],
    ["case-drifted NoProfile", (f, h) => ({ rawHostCommandLine: reviewedHostText(f, "Execute", h).replace("-NoProfile", "-noprofile") })],
    ["case-drifted NonInteractive", (f, h) => ({ rawHostCommandLine: reviewedHostText(f, "Execute", h).replace("-NonInteractive", "-noninteractive") })],
    ["case-drifted File", (f, h) => ({ rawHostCommandLine: reviewedHostText(f, "Execute", h).replace("-File", "-file") })],
    ["abbreviated NoProfile", (f, h) => ({ rawHostCommandLine: reviewedHostText(f, "Execute", h).replace("-NoProfile", "-NoP") })],
    ["abbreviated NonInteractive", (f, h) => ({ rawHostCommandLine: reviewedHostText(f, "Execute", h).replace("-NonInteractive", "-NonI") })],
    ["abbreviated File", (f, h) => ({ rawHostCommandLine: reviewedHostText(f, "Execute", h).replace("-File", "-F") })],
    ["NoLogo", (f, h) => ({ rawHostCommandLine: reviewedHostText(f, "Execute", h).replace(" -NoProfile", " -NoLogo -NoProfile") })],
    ["ExecutionPolicy", (f, h) => ({ rawHostCommandLine: reviewedHostText(f, "Execute", h).replace(" -File", " -ExecutionPolicy Bypass -File") })],
    ["EncodedCommand", (f, h) => ({ rawHostCommandLine: reviewedHostText(f, "Execute", h).replace(" -File", " -EncodedCommand QQ== -File") })],
    ["Command", (f, h) => ({ rawHostCommandLine: reviewedHostText(f, "Execute", h).replace(" -File", " -Command Get-Date -File") })],
    ["common parameter", (f, h) => ({ rawHostCommandLine: reviewedHostText(f, "Execute", h) + " -Verbose" })],
    ["unquoted script path", (f, h) => ({ rawHostCommandLine: reviewedHostText(f, "Execute", h).replace(`"${f.paths.envelope}"`, f.paths.envelope) })],
    ["unquoted manifest path", (f, h) => ({ rawHostCommandLine: reviewedHostText(f, "Execute", h).replace(`"${f.paths.manifest}"`, f.paths.manifest) })],
    ["alternate image identity", (f) => ({ metadataHostPath: f.paths.node })],
    ["alternate image token", (f, h) => ({ rawHostCommandLine: reviewedHostText(f, "Execute", h).replace(`"${f.paths.host}"`, `"${f.paths.node}"`) })],
    ["alternate script token", (f, h) => ({ rawHostCommandLine: reviewedHostText(f, "Execute", h).replace(`"${f.paths.envelope}"`, `"${f.paths.controller}"`) })],
    ["wrong actual script", (f) => ({ metadataEnvelopePath: f.paths.controller })],
    ["missing actual script", () => ({ metadataEnvelopePath: null })],
    ["raw round-trip mismatch", (f, h) => ({ rawHostCommandLine: reviewedHostText(f, "Execute", h).replace("-NoProfile", '"-NoProfile"') })],
    ["extra leading text", (f, h) => ({ rawHostCommandLine: " " + reviewedHostText(f, "Execute", h) })],
    ["extra trailing text", (f, h) => ({ rawHostCommandLine: reviewedHostText(f, "Execute", h) + " " })],
    ["mode drift", (f, h) => ({ rawHostCommandLine: reviewedHostText(f, "AuditOnly", h) })],
  ];
  it.each(outerHostMutations)("rejects outer-host mutation %s before manifest open or filesystem changes", async (_name, mutate) => {
    const fixture = await createFixture();
    try {
      const bytes = Buffer.from(JSON.stringify(fixture.document)); const before = await snapshotFixture(fixture);
      expect(await validateManifestBytes(fixture, "Execute", bytes, mutate(fixture, sha256(bytes)))).toMatchObject({ ok: false, category: "authorization-invalid", manifestOpens: 0 });
      expect(await snapshotFixture(fixture)).toEqual(before);
    } finally { await disposeFixture(fixture); }
  });

  it.each(authorizationKeys)("rejects authorization manifest missing key %s", async (key) => {
    const fixture = await createFixture();
    try { const document = { ...fixture.document } as Record<string, unknown>; delete document[key]; expect(await validateManifest(fixture, "Execute", document)).toMatchObject({ ok: false, category: "authorization-invalid" }); }
    finally { await disposeFixture(fixture); }
  });
  it.each(authorizationKeys)("rejects ordinal case drift for authorization key %s", async (key) => {
    const fixture = await createFixture();
    try { const document = { ...fixture.document } as Record<string, unknown>; const value = document[key]; delete document[key]; document[caseDrift(key)] = value; expect(await validateManifest(fixture, "Execute", document)).toMatchObject({ ok: false, category: "authorization-invalid" }); }
    finally { await disposeFixture(fixture); }
  });
  it.each(wrongAuthorizationTypeCases)("rejects wrong %s-to-%s authorization type", async (key, wrongType) => {
    const fixture = await createFixture();
    try {
      const document = { ...fixture.document } as Record<string, unknown>;
      document[key] = wrongJsonValue(wrongType, document[key]);
      expect(await validateManifest(fixture, "Execute", document)).toMatchObject({ ok: false, category: "authorization-invalid" });
    } finally { await disposeFixture(fixture); }
  });

  const fixedFieldMutations: Array<[AuthorizationKey, (fixture: Fixture) => unknown]> = [
    ["schema", () => "intentarc.preflight-execution-authorization/v2"], ["attemptId", () => "phase1-preflight-envelope-20260902-02"],
    ["controllerRunId", () => "phase1-preflight-20260901-07"], ["jobName", () => "IntentArc.Preflight.phase1-preflight-20260901-07"],
    ["canonicalPath", (f) => f.root + " changed"], ["branch", () => "main"], ["authorizationManifestPath", (f) => f.paths.controller],
    ["envelopePath", (f) => f.paths.controller], ["controllerPath", (f) => f.paths.envelope], ["gitPath", (f) => f.paths.node],
    ["nodePath", (f) => f.paths.git], ["cmdPath", (f) => f.paths.pnpm], ["pnpmPath", (f) => f.paths.cmd], ["outerPowerShellPath", (f) => f.paths.node],
  ];
  it.each(fixedFieldMutations)("rejects wrong fixed manifest field %s", async (key, replacement) => {
    const fixture = await createFixture();
    try { expect(await validateManifest(fixture, "Execute", { ...fixture.document, [key]: replacement(fixture) })).toMatchObject({ ok: false }); }
    finally { await disposeFixture(fixture); }
  });
  it.each([["short", "0".repeat(39)], ["long", "0".repeat(41)], ["uppercase", "A".repeat(40)], ["nonhex", "g".repeat(40)]])("rejects %s expectedCommit", async (_name, value) => {
    const fixture = await createFixture();
    try { expect(await validateManifest(fixture, "Execute", { ...fixture.document, expectedCommit: value })).toMatchObject({ ok: false }); }
    finally { await disposeFixture(fixture); }
  });
  it.each([["maximumControllerStdoutBytes", 1048575], ["maximumControllerStdoutBytes", 1048577], ["maximumControllerStderrBytes", 1048575], ["maximumControllerStderrBytes", 1048577], ["maximumAttempts", 0], ["maximumAttempts", 2]] as const)("rejects manifest numeric boundary %s=%s", async (key, value) => {
    const fixture = await createFixture();
    try { expect(await validateManifest(fixture, "Execute", { ...fixture.document, [key]: value })).toMatchObject({ ok: false }); }
    finally { await disposeFixture(fixture); }
  });
  it.each(["retryAuthorized", "restoreOnlyAuthorized", "signedReleaseAuthorized"] as const)("rejects true authority %s", async (key) => {
    const fixture = await createFixture();
    try { expect(await validateManifest(fixture, "Execute", { ...fixture.document, [key]: true })).toMatchObject({ ok: false }); }
    finally { await disposeFixture(fixture); }
  });
  it.each(hashKeys.flatMap((key) => [[`${key} uppercase`, key, "A".repeat(64)], [`${key} malformed`, key, "g".repeat(64)], [`${key} mismatch`, key, "0".repeat(64)]] as const))("rejects manifest hash mutation %s", async (_name, key, value) => {
    const fixture = await createFixture();
    try { expect(await validateManifest(fixture, "Execute", { ...fixture.document, [key]: value })).toMatchObject({ ok: false }); }
    finally { await disposeFixture(fixture); }
  });

  it.each([
    ["malformed UTF-8", (json: Buffer) => Buffer.concat([json.subarray(0, 1), Buffer.from([0xc3, 0x28]), json.subarray(1)])],
    ["UTF-8 BOM", (json: Buffer) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), json])],
    ["root duplicate", (json: Buffer) => Buffer.from(json.toString().replace("{", '{"schema":"duplicate",'))],
    ["escaped root duplicate", (json: Buffer) => Buffer.from(json.toString().replace("{", '{"\\u0073chema":"duplicate",'))],
    ["nested duplicate", (json: Buffer) => Buffer.from(json.toString().replace(/\}$/u, ',"nested":{"x":1,"x":2}}'))],
    ["trailing value", (json: Buffer) => Buffer.concat([json, Buffer.from("{}")])], ["trailing byte", (json: Buffer) => Buffer.concat([json, Buffer.from([0])])],
    ["trailing JSON whitespace", (json: Buffer) => Buffer.concat([json, Buffer.from(" \r\n")])],
    ["non-JSON whitespace", (json: Buffer) => Buffer.concat([Buffer.from([0xc2, 0xa0]), json])],
  ] as const)("rejects ambiguous authorization bytes: %s", async (_name, mutate) => {
    const fixture = await createFixture();
    try { expect(await validateManifestBytes(fixture, "Execute", mutate(Buffer.from(JSON.stringify(fixture.document))))).toMatchObject({ ok: false, category: "authorization-invalid" }); }
    finally { await disposeFixture(fixture); }
  });

  it("rejects duplicate names inside a nested object before schema validation", async () => {
    const body = `. ${quote(scriptPath)}; $rejected=$false; try { Assert-IntentArcPreflightExecutionJsonHasNoDuplicateKeys -Text '{"outer":{"name":1,"name":2}}' } catch { $rejected=$true }; [ordered]@{rejected=$rejected}|ConvertTo-Json -Compress`;
    expect(JSON.parse(await runPowerShell(body))).toEqual({ rejected: true });
  });

  it.each([[65536, true], [65537, false]] as const)("enforces the exact 65,536-byte manifest boundary at %s bytes", async (size, accepted) => {
    const fixture = await createFixture();
    try {
      const json = JSON.stringify(fixture.document); const padding = size - Buffer.byteLength(json);
      expect(padding).toBeGreaterThan(0);
      const bytes = Buffer.from(`{${" ".repeat(padding)}${json.slice(1)}`); expect(bytes.length).toBe(size);
      expect(await validateManifestBytes(fixture, "Execute", bytes)).toMatchObject(accepted ? { ok: true } : { ok: false, category: "authorization-invalid" });
    } finally { await disposeFixture(fixture); }
  });

  it("rejects extra keys, mismatched supplied digest, invalid timestamp, envelope self mismatch, and bound-file mismatch", async () => {
    const fixture = await createFixture();
    try {
      expect(await validateManifest(fixture, "Execute", { ...fixture.document, extra: "forbidden" })).toMatchObject({ ok: false });
      expect(await validateManifestBytes(fixture, "Execute", Buffer.from(JSON.stringify(fixture.document)), { expectedSha256: "0".repeat(64) })).toMatchObject({ ok: false });
      expect(await validateManifest(fixture, "Execute", { ...fixture.document, createdAtUtc: "2026-09-02T00:00:00Z" })).toMatchObject({ ok: false });
      expect(await validateManifest(fixture, "Execute", { ...fixture.document, envelopePath: fixture.paths.controller })).toMatchObject({ ok: false });
      expect(await validateManifest(fixture, "Execute", { ...fixture.document, envelopeSha256: fixture.document.controllerSha256 })).toMatchObject({ ok: false });
    } finally { await disposeFixture(fixture); }
  });

  it("returns the required namespaced pinned guard and disposable validated context", async () => {
    const fixture = await createFixture();
    try { expect(await validateManifest(fixture, "Execute")).toMatchObject({ ok: true, contextType: "IntentArc.PreflightEnvelope.ValidatedAuthorizationContext", guardType: "IntentArc.PreflightEnvelope.PinnedManifestFile", expectedFinalPath: `\\\\?\\${fixture.paths.manifest}` }); }
    finally { await disposeFixture(fixture); }
  });
  it.each([
    ["initial final path", { manifestInitialFault: "FinalPath" }], ["initial zero volume identity", { manifestInitialFault: "ZeroVolume" }],
    ["initial zero file identity", { manifestInitialFault: "ZeroFileId" }], ["initial file type", { manifestInitialFault: "Directory" }],
    ["initial reparse fact", { manifestInitialFault: "Reparse" }], ["post-read final path", { manifestPostReadFault: "FinalPath" }],
    ["post-read volume identity", { manifestPostReadFault: "Volume" }], ["post-read file identity", { manifestPostReadFault: "Identity" }],
    ["post-read file type", { manifestPostReadFault: "Directory" }], ["post-read reparse fact", { manifestPostReadFault: "Reparse" }],
  ] as const)("rejects pinned-manifest observation drift: %s", async (_name, options) => {
    const fixture = await createFixture();
    try { expect(await validateManifest(fixture, "Execute", fixture.document, options)).toMatchObject({ ok: false, category: "authorization-invalid", manifestOpens: 1, faultApplications: 1 }); }
    finally { await disposeFixture(fixture); }
  });
  const boundFaultCases = boundNames.flatMap((name) => [
    [name, "initial", "FinalPath"], [name, "initial", "ZeroVolume"], [name, "initial", "ZeroFileId"],
    [name, "initial", "Directory"], [name, "initial", "Reparse"], [name, "post", "FinalPath"],
    [name, "post", "Volume"], [name, "post", "Identity"], [name, "post", "Directory"], [name, "post", "Reparse"],
  ] as const);
  it.each(boundFaultCases)("hashes bound file %s through pinned %s %s revalidation", async (name, phase, fault) => {
    const fixture = await createFixture();
    try { expect(await validateManifest(fixture, "Execute", fixture.document, { boundFault: { name, phase, fault } })).toMatchObject({ ok: false, category: "authorization-invalid", manifestOpens: 1, faultApplications: 1 }); }
    finally { await disposeFixture(fixture); }
  });

  it("rejects a manifest whose parent junction changes its final path", async () => {
    const fixture = await createFixture(); const aliasContainer = await mkdtemp(join(tmpdir(), "intentarc alias container ")); const aliasRoot = join(aliasContainer, "root alias");
    try {
      await symlink(fixture.root, aliasRoot, "junction");
      const replaceRoot = (value: string) => value.replace(fixture.root, aliasRoot);
      const paths = Object.fromEntries(Object.entries(fixture.paths).map(([name, path]) => [name, replaceRoot(path)])) as Fixture["paths"];
      const document = { ...fixture.document, canonicalPath: aliasRoot, authorizationManifestPath: paths.manifest, envelopePath: paths.envelope, controllerPath: paths.controller, gitPath: paths.git, nodePath: paths.node, cmdPath: paths.cmd, pnpmPath: paths.pnpm, outerPowerShellPath: paths.host };
      const aliased = { root: aliasRoot, paths, document } as Fixture;
      expect(await validateManifest(aliased, "Execute")).toMatchObject({ ok: false, category: "authorization-invalid", manifestOpens: 1 });
    } finally { await rmdir(aliasRoot).catch(() => undefined); await rm(aliasContainer, { recursive: true, force: true }); await disposeFixture(fixture); }
  });
  it("rejects a final-component manifest file symlink", async (context) => {
    const fixture = await createFixture(); const symlinkPath = join(fixture.root, "manifest symlink.json");
    try {
      try { await symlink(fixture.paths.manifest, symlinkPath, "file"); }
      catch (error) {
        if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) { context.skip(); return; }
        throw error;
      }
      const aliased = { ...fixture, paths: { ...fixture.paths, manifest: symlinkPath }, document: { ...fixture.document, authorizationManifestPath: symlinkPath } };
      expect(await validateManifest(aliased, "Execute")).toMatchObject({ ok: false, category: "authorization-invalid", manifestOpens: 1 });
    } finally { await rm(symlinkPath, { force: true }); await disposeFixture(fixture); }
  });

  it("accepts only canonical production contracts or marked dot-source test contracts", async () => {
    const fixture = await createFixture();
    try {
      const body = `. ${quote(scriptPath)}; $production=New-IntentArcPreflightEnvelopeProductionContract; $overrideRejected=$false; try {[void](New-IntentArcPreflightEnvelopeProductionContract 'override')} catch {$overrideRejected=$true}; $test=${contractExpression(fixture)}; $forged=[pscustomobject]@{Internal=$true;Root=$test.Root;ExecutableBindings=$test.ExecutableBindings;TestHooks=$test.TestHooks}; $changed=New-IntentArcPreflightEnvelopeProductionContract; $changed.Root='C:\\changed'; $extra=New-IntentArcPreflightEnvelopeProductionContract; $extra|Add-Member -NotePropertyName Extra -NotePropertyValue $true; [ordered]@{production=(Test-IntentArcPreflightEnvelopeContract $production);overrideRejected=$overrideRejected;test=(Test-IntentArcPreflightEnvelopeContract $test);forged=(Test-IntentArcPreflightEnvelopeContract $forged);changed=(Test-IntentArcPreflightEnvelopeContract $changed);extra=(Test-IntentArcPreflightEnvelopeContract $extra)}|ConvertTo-Json -Compress`;
      expect(JSON.parse(await runPowerShell(body))).toEqual({ production: true, overrideRejected: true, test: true, forged: false, changed: false, extra: false });
    } finally { await disposeFixture(fixture); }
  });
  it("pins every production contract literal independently", async () => {
    const body = `. ${quote(scriptPath)}; $contract=New-IntentArcPreflightEnvelopeProductionContract; [ordered]@{root=$contract.Root;manifest=$contract.AuthorizationManifestPath;envelope=$contract.ExecutableBindings.envelope;controller=$contract.ExecutableBindings.controller;git=$contract.ExecutableBindings.git;node=$contract.ExecutableBindings.node;cmd=$contract.ExecutableBindings.cmd;pnpm=$contract.ExecutableBindings.pnpm;host=$contract.ExecutableBindings.host}|ConvertTo-Json -Compress`;
    expect(JSON.parse(await runPowerShell(body))).toEqual({
      root: "C:\\projects\\Project Manager", manifest: productionManifestPath,
      envelope: "C:\\projects\\Project Manager\\scripts\\desktop-release-preflight-once.ps1",
      controller: "C:\\projects\\Project Manager\\scripts\\desktop-release-preflight-out-preservation.ps1",
      git: "C:\\Program Files\\Git\\cmd\\git.exe", node: "C:\\Program Files\\nodejs\\node.exe",
      cmd: "C:\\Windows\\System32\\cmd.exe",
      pnpm: "C:\\Users\\synthetic-user\\AppData\\Local\\pnpm\\global\\v11\\synthetic-install\\node_modules\\@pnpm\\exe\\pnpm.exe",
      host: powerShell,
    });
  });
  it.each(["C:relative", "\\root-relative"])("rejects non-fully-qualified internal path %s before any manifest open", async (invalidPath) => {
    const fixture = await createFixture();
    try {
      const hash = "0".repeat(64); const raw = reviewedHostText(fixture, "Execute", hash).replace(`"${fixture.paths.manifest}"`, `"${invalidPath}"`);
      const body = [`. ${quote(scriptPath)}`, `$validBindings=${bindingsExpression(fixture)}`, `$rootRejected=$false; try {[void](New-IntentArcPreflightEnvelopeTestContract -Root ${quote(invalidPath)} -ExecutableBindings $validBindings)} catch {$rootRejected=$true}`, `$invalidBindings=${bindingsExpression(fixture)}; $invalidBindings.envelope=${quote(invalidPath)}`, `$bindingRejected=$false; try {[void](New-IntentArcPreflightEnvelopeTestContract -Root ${quote(fixture.root)} -ExecutableBindings $invalidBindings)} catch {$bindingRejected=$true}`, `$contract=${contractExpression(fixture)}`, `$invocation=[pscustomobject]@{mode='Execute';manifestPath=${quote(invalidPath)};expectedSha256='${hash}';InvocationMetadata=[pscustomobject]@{HostImagePath=${quote(fixture.paths.host)};EnvelopePath=${quote(fixture.paths.envelope)};RawCommandLine=${quote(raw)}}}`, `$manifestRejected=$false; try {[void](Read-IntentArcPreflightExecutionAuthorizationManifest -LiteralPath ${quote(invalidPath)} -ExpectedSha256 '${hash}' -ActualInvocation $invocation -Contract $contract)} catch {$manifestRejected=$true}`, `[ordered]@{rootRejected=$rootRejected;bindingRejected=$bindingRejected;manifestRejected=$manifestRejected;manifestOpens=$contract.TestHooks.ManifestOpenCount}|ConvertTo-Json -Compress`].join("\n");
      expect(JSON.parse(await runPowerShell(body))).toEqual({ rootRejected: true, bindingRejected: true, manifestRejected: true, manifestOpens: 0 });
    } finally { await disposeFixture(fixture); }
  });
  it("keeps issued test contracts immutable and their registry private", async () => {
    const fixture = await createFixture();
    try {
      const body = `. ${quote(scriptPath)}; $test=${contractExpression(fixture)}; $rootBlocked=$false; try {$test.Root='relative'} catch {$rootBlocked=$true}; $bindingBlocked=$false; try {$test.ExecutableBindings['controller']='relative'} catch {$bindingBlocked=$true}; $forged=[pscustomobject]@{Internal=$true;Root=$test.Root;ExecutableBindings=$test.ExecutableBindings;TestHooks=$test.TestHooks}; $registryBlocked=$false; try {$script:IntentArcPreflightEnvelopeIssuedTestContracts.Add($forged); $registryBlocked=-not (Test-IntentArcPreflightEnvelopeContract $forged)} catch {$registryBlocked=$true}; [ordered]@{rootBlocked=$rootBlocked;bindingBlocked=$bindingBlocked;registryBlocked=$registryBlocked;forgedAccepted=(Test-IntentArcPreflightEnvelopeContract $forged);issuedStillValid=(Test-IntentArcPreflightEnvelopeContract $test)}|ConvertTo-Json -Compress`;
      expect(JSON.parse(await runPowerShell(body))).toEqual({ rootBlocked: true, bindingBlocked: true, registryBlocked: true, forgedAccepted: false, issuedStillValid: true });
    } finally { await disposeFixture(fixture); }
  });
  it("allows the exact production contract to reach manifest admission", async () => {
    const hash = "0".repeat(64);
    const raw = `"${powerShell}" -NoProfile -NonInteractive -File "C:\\projects\\Project Manager\\scripts\\desktop-release-preflight-once.ps1" -Execute -AuthorizationManifest "${productionManifestPath}" -ExpectedAuthorizationSha256 ${hash}`;
    const body = `. ${quote(scriptPath)}; $contract=New-IntentArcPreflightEnvelopeProductionContract; $invocation=[pscustomobject]@{mode='Execute';manifestPath=${quote(productionManifestPath)};expectedSha256='${hash}';InvocationMetadata=[pscustomobject]@{HostImagePath=${quote(powerShell)};EnvelopePath='C:\\projects\\Project Manager\\scripts\\desktop-release-preflight-once.ps1';RawCommandLine=${quote(raw)}}}; $script:openCount=0; function Open-IntentArcPreflightExecutionPinnedManifestFile { param($LiteralPath,$ExpectedFinalPath,$Contract,$Purpose) $script:openCount++; throw 'authorization-invalid' }; try {[void](Read-IntentArcPreflightExecutionAuthorizationManifest -LiteralPath ${quote(productionManifestPath)} -ExpectedSha256 '${hash}' -ActualInvocation $invocation -Contract $contract)} catch {}; [ordered]@{manifestOpens=$script:openCount}|ConvertTo-Json -Compress`;
    expect(JSON.parse(await runPowerShell(body))).toEqual({ manifestOpens: 1 });
  });
  it("collects no-argument production metadata from the live image, command line, and PSCommandPath", async () => {
    const source = await readFile(scriptPath, "utf8");
    expect(source).toContain("QueryFullProcessImageNameW"); expect(source).toContain("GetCommandLineW"); expect(source).toContain("$actualScriptPath = $PSCommandPath");
    const body = `. ${quote(scriptPath)}; $metadata=Get-IntentArcPreflightExecutionProductionInvocationMetadata; $overrideRejected=$false; try {[void](Get-IntentArcPreflightExecutionProductionInvocationMetadata 'override')} catch {$overrideRejected=$true}; [ordered]@{host=$metadata.HostImagePath;commandLinePresent=($metadata.RawCommandLine -is [string] -and $metadata.RawCommandLine.Length -gt 0);envelope=$metadata.EnvelopePath;overrideRejected=$overrideRejected}|ConvertTo-Json -Compress`;
    expect(JSON.parse(await runPowerShell(body))).toEqual({ host: powerShell, commandLinePresent: true, envelope: scriptPath, overrideRejected: true });
  });
  it.each(boundNames)("holds manifest and %s identities until context disposal", async (boundName) => {
    const fixture = await createFixture();
    try {
      const bytes = Buffer.from(JSON.stringify(fixture.document)); await writeFile(fixture.paths.manifest, bytes);
      const hash = sha256(bytes); const raw = reviewedHostText(fixture, "Execute", hash);
      const boundPath = fixture.paths[boundName]; const manifestMoved = fixture.paths.manifest + ".moved"; const boundMoved = boundPath + ".moved";
      const body = [`. ${quote(scriptPath)}`, `$contract=${contractExpression(fixture)}`, `$invocation=[pscustomobject]@{mode='Execute';manifestPath=${quote(fixture.paths.manifest)};expectedSha256='${hash}';InvocationMetadata=[pscustomobject]@{HostImagePath=${quote(fixture.paths.host)};EnvelopePath=${quote(fixture.paths.envelope)};RawCommandLine=${quote(raw)}}}`, `$context=Read-IntentArcPreflightExecutionAuthorizationManifest -LiteralPath ${quote(fixture.paths.manifest)} -ExpectedSha256 '${hash}' -ActualInvocation $invocation -Contract $contract`, "$manifestBlocked=$false; try {Move-Item -LiteralPath $invocation.manifestPath -Destination ($invocation.manifestPath+'.moved') -ErrorAction Stop} catch {$manifestBlocked=$true}", `$boundBlocked=$false; try {Move-Item -LiteralPath ${quote(boundPath)} -Destination ${quote(boundMoved)} -ErrorAction Stop} catch {$boundBlocked=$true}`, "$context.Dispose()", `Move-Item -LiteralPath ${quote(fixture.paths.manifest)} -Destination ${quote(manifestMoved)} -ErrorAction Stop`, `Move-Item -LiteralPath ${quote(boundPath)} -Destination ${quote(boundMoved)} -ErrorAction Stop`, `[ordered]@{manifestBlocked=$manifestBlocked;boundBlocked=$boundBlocked;manifestReleased=(Test-Path -LiteralPath ${quote(manifestMoved)});boundReleased=(Test-Path -LiteralPath ${quote(boundMoved)})}|ConvertTo-Json -Compress`].join("\n");
      expect(JSON.parse(await runPowerShell(body))).toEqual({ manifestBlocked: true, boundBlocked: true, manifestReleased: true, boundReleased: true });
    } finally { await disposeFixture(fixture); }
  });
  it("releases every retained handle even when one child disposal reports a fault", async () => {
    const fixture = await createFixture();
    try {
      const bytes = Buffer.from(JSON.stringify(fixture.document)); await writeFile(fixture.paths.manifest, bytes);
      const hash = sha256(bytes); const raw = reviewedHostText(fixture, "Execute", hash); const heldPaths = [fixture.paths.manifest, ...boundNames.map((name) => fixture.paths[name])];
      const body = [`. ${quote(scriptPath)}`, `$contract=${contractExpression(fixture)}`, `if ($null -ne $contract.TestHooks.PSObject.Properties['DisposeFaultName']) {$contract.TestHooks.DisposeFaultName='controller'} else {$contract.TestHooks|Add-Member -NotePropertyName DisposeFaultName -NotePropertyValue 'controller'}`, `$invocation=[pscustomobject]@{mode='Execute';manifestPath=${quote(fixture.paths.manifest)};expectedSha256='${hash}';InvocationMetadata=[pscustomobject]@{HostImagePath=${quote(fixture.paths.host)};EnvelopePath=${quote(fixture.paths.envelope)};RawCommandLine=${quote(raw)}}}`, `$context=Read-IntentArcPreflightExecutionAuthorizationManifest -LiteralPath ${quote(fixture.paths.manifest)} -ExpectedSha256 '${hash}' -ActualInvocation $invocation -Contract $contract`, `$disposeFaultObserved=$false; try {$context.Dispose()} catch {$disposeFaultObserved=$true}`, `$allReleased=$true; foreach ($path in @(${heldPaths.map(quote).join(",")})) {try {Move-Item -LiteralPath $path -Destination ($path+'.moved') -ErrorAction Stop} catch {$allReleased=$false}}`, `[ordered]@{disposeFaultObserved=$disposeFaultObserved;allReleased=$allReleased}|ConvertTo-Json -Compress`].join("\n");
      expect(JSON.parse(await runPowerShell(body))).toEqual({ disposeFaultObserved: true, allReleased: true });
    } finally { await disposeFixture(fixture); }
  });
  it("admits the exact reviewed direct command but rejects raw test selectors before its observable gate", async () => {
    const fixture = await createFixture();
    try {
      const directScriptPath = join(fixture.root, "reviewed direct envelope.ps1"); const admissionMarker = join(fixture.root, "admission marker.txt");
      const original = await readFile(scriptPath, "utf8");
      const copied = original
        .replace(/^\$script:IntentArcPreflightExecutionManifestPath = .*$/m, `$script:IntentArcPreflightExecutionManifestPath = ${quote(fixture.paths.manifest)}`)
        .replace(/^\$script:IntentArcPreflightExecutionEnvelopePath = .*$/m, `$script:IntentArcPreflightExecutionEnvelopePath = ${quote(directScriptPath)}`)
        .replace("        $result = Invoke-IntentArcPreflightEnvelopeHost -Invocation $invocation", `        [IO.File]::WriteAllText(${quote(admissionMarker)}, ($productionContract.Internal.ToString() + '|' + $productionContract.Root))\n        $result = Invoke-IntentArcPreflightEnvelopeHost -Invocation $invocation`);
      expect(copied).not.toBe(original); expect(copied).toContain(quote(directScriptPath)); expect(copied).toContain(quote(admissionMarker));
      await writeFile(directScriptPath, copied, "utf8");
      const exactTokens = ["-Execute", "-AuthorizationManifest", fixture.paths.manifest, "-ExpectedAuthorizationSha256", "0".repeat(64)] as const;
      expectClosedDirectRefusal(await runReviewedDirect(exactTokens, directScriptPath));
      expect(await readFile(admissionMarker, "utf8")).toBe("False|C:\\projects\\Project Manager");
      const rawSelectors = [
        ["raw Contract", [...exactTokens, "-Contract", "test"]], ["raw test mode", ["-TestContract", ...exactTokens]],
        ["raw operation factory", [...exactTokens, "-OperationFactory", "test"]], ["raw Root", [...exactTokens, "-Root", "C:\\test"]],
        ["raw executable bindings", [...exactTokens, "-ExecutableBindings", "test"]],
        ["forbidden RestoreOnly mode", ["-RestoreOnly", ...exactTokens.slice(1)]],
      ] as const;
      for (const [_name, tokens] of rawSelectors) {
        await rm(admissionMarker, { force: true }); expectClosedDirectRefusal(await runReviewedDirect(tokens, directScriptPath));
        expect(await readFile(admissionMarker, "utf8").catch(() => null)).toBeNull();
      }
      await rm(admissionMarker, { force: true });
      expectClosedDirectRefusal(await runReviewedDirect(exactTokens, directScriptPath, undefined, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File"]));
      expect(await readFile(admissionMarker, "utf8").catch(() => null)).toBeNull();
    } finally { await disposeFixture(fixture); }
  });
  it("ignores environment test selectors while using the production contract at the observable direct gate", async () => {
    const fixture = await createFixture();
    try {
      const directScriptPath = join(fixture.root, "reviewed environment envelope.ps1"); const admissionMarker = join(fixture.root, "environment admission marker.txt");
      const original = await readFile(scriptPath, "utf8");
      const copied = original
        .replace(/^\$script:IntentArcPreflightExecutionManifestPath = .*$/m, `$script:IntentArcPreflightExecutionManifestPath = ${quote(fixture.paths.manifest)}`)
        .replace(/^\$script:IntentArcPreflightExecutionEnvelopePath = .*$/m, `$script:IntentArcPreflightExecutionEnvelopePath = ${quote(directScriptPath)}`)
        .replace("        $result = Invoke-IntentArcPreflightEnvelopeHost -Invocation $invocation", `        [IO.File]::WriteAllText(${quote(admissionMarker)}, ($productionContract.Internal.ToString() + '|' + $productionContract.Root))\n        $result = Invoke-IntentArcPreflightEnvelopeHost -Invocation $invocation`);
      await writeFile(directScriptPath, copied, "utf8");
      const exactTokens = ["-Execute", "-AuthorizationManifest", fixture.paths.manifest, "-ExpectedAuthorizationSha256", "0".repeat(64)] as const;
      expectClosedDirectRefusal(await runReviewedDirect(exactTokens, directScriptPath, { ...process.env, INTENTARC_PREFLIGHT_TEST_CONTRACT: "1", INTENTARC_PREFLIGHT_OPERATION_FACTORY: "test" }));
      expect(await readFile(admissionMarker, "utf8")).toBe("False|C:\\projects\\Project Manager");
    } finally { await disposeFixture(fixture); }
  });
  it.each([["contract", "$productionContract = New-IntentArcPreflightEnvelopeProductionContract"], ["contract-validation", "if (-not (Test-IntentArcPreflightEnvelopeContract $productionContract))"], ["native-metadata", "$metadata = Get-IntentArcPreflightExecutionProductionInvocationMetadata"], ["parser", "$invocation = Test-IntentArcPreflightOnceInvocation"], ["outer-binding", "if ($null -eq $invocation -or -not (Test-IntentArcPreflightExecutionOuterHostBinding"], ["refusal", "$result = Invoke-IntentArcPreflightEnvelopeHost -Invocation $invocation"], ["serialization", "$candidateJson = $result | ConvertTo-Json"]] as const)("direct footer closes %s faults to exactly one audit JSON", async (stage, sourceNeedle) => {
    const fixture = await createFixture();
    try {
      const faultedPath = join(fixture.root, `faulted-${stage}.ps1`); const reachedMarker = join(fixture.root, `reached-${stage}.txt`);
      const source = await readFile(scriptPath, "utf8");
      const rebound = source
        .replace(/^\$script:IntentArcPreflightExecutionManifestPath = .*$/m, `$script:IntentArcPreflightExecutionManifestPath = ${quote(fixture.paths.manifest)}`)
        .replace(/^\$script:IntentArcPreflightExecutionEnvelopePath = .*$/m, `$script:IntentArcPreflightExecutionEnvelopePath = ${quote(faultedPath)}`);
      const faulted = rebound.replace(sourceNeedle, `[IO.File]::WriteAllText(${quote(reachedMarker)}, ${quote(stage)}); throw 'sensitive-${stage}-fault'; ${sourceNeedle}`);
      expect(faulted).not.toBe(rebound); await writeFile(faultedPath, faulted, "utf8");
      const exactTokens = ["-Execute", "-AuthorizationManifest", fixture.paths.manifest, "-ExpectedAuthorizationSha256", "0".repeat(64)] as const;
      expectClosedDirectRefusal(await runReviewedDirect(exactTokens, faultedPath)); expect(await readFile(reachedMarker, "utf8")).toBe(stage);
    } finally { await disposeFixture(fixture); }
  });
});

describe.sequential("desktop release preflight once boundary guard, three-state probes, and protected evidence", () => {
  it("classifies present, exact-not-found, sharing-violation, and invalid-name entries with three-state semantics", async () => {
    const fixture = await createFixture();
    try {
      const missing = join(fixture.root, "missing entry");
      const body = [
        `$file=${quote(fixture.paths.controller)}`,
        `$directory=${quote(fixture.root)}`,
        `$missing=${quote(missing)}`,
        "$lease=[IO.File]::Open($file,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None)",
        "try {$sharing=[IntentArc.PreflightEnvelope.EntryProbe]::Probe($file).ToString()} finally {$lease.Dispose()}",
        "$invalid=[IntentArc.PreflightEnvelope.EntryProbe]::Probe(([string][char]0)).ToString()",
        "[ordered]@{file=[IntentArc.PreflightEnvelope.EntryProbe]::Probe($file).ToString();directory=[IntentArc.PreflightEnvelope.EntryProbe]::Probe($directory).ToString();missing=[IntentArc.PreflightEnvelope.EntryProbe]::Probe($missing).ToString();sharing=$sharing;invalid=$invalid}|ConvertTo-Json -Compress",
      ].join("\n");
      expect(await runBoundaryHarness(body)).toEqual({ file: "Present", directory: "Present", missing: "Absent", sharing: "Indeterminate", invalid: "Indeterminate" });
    } finally { await disposeFixture(fixture); }
  });

  it("treats access denial as indeterminate rather than absence", async () => {
    const outcome = await runBoundaryHarness("[ordered]@{value=[IntentArc.PreflightEnvelope.EntryProbe]::Probe('C:\\System Volume Information').ToString()}|ConvertTo-Json -Compress");
    expect(outcome).toEqual({ value: "Indeterminate" });
  });

  it("pins ordinary files to their final path and stable same-handle bytes", async () => {
    const fixture = await createFixture();
    try {
      const expected = `\\\\?\\${fixture.paths.controller}`;
      const body = [
        `$guard=[IntentArc.PreflightEnvelope.BoundaryGuard]::OpenFile(${quote(fixture.paths.controller)},${quote(fixture.paths.controller)})`,
        "try {$bytes=$guard.ReadAllBytes(65536);$answer=[ordered]@{canonical=$guard.CanonicalPath;identity=$guard.StableIdentity;text=[Text.Encoding]::UTF8.GetString($bytes);revalidated=$guard.Revalidate()}} finally {$guard.Dispose()}",
        "$answer|ConvertTo-Json -Compress",
      ].join("\n");
      expect(await runBoundaryHarness(body)).toEqual({ canonical: expected, identity: expect.stringMatching(/^[0-9a-f]{8}:[0-9a-f]{16}$/), text: `fixture:controller:${fixture.paths.controller}`, revalidated: true });
    } finally { await disposeFixture(fixture); }
  });

  it("rejects type confusion, final-path mismatch, and reparse ancestors", async () => {
    const fixture = await createFixture(); const aliasParent = await mkdtemp(join(tmpdir(), "intentarc boundary alias ")); const alias = join(aliasParent, "root alias");
    try {
      await symlink(fixture.root, alias, "junction");
      const aliasedFile = join(alias, "desktop release preflight out preservation.ps1");
      const body = [
        "$ordinary=[IntentArc.PreflightEnvelope.BoundaryGuard]::OpenFile(" + quote(fixture.paths.controller) + "," + quote(fixture.paths.controller) + ");$ordinary.Dispose()",
        "$fileAsDirectory=$false;try{[void][IntentArc.PreflightEnvelope.BoundaryGuard]::OpenDirectory(" + quote(fixture.paths.controller) + "," + quote(fixture.paths.controller) + ")}catch{$fileAsDirectory=$true}",
        "$directoryAsFile=$false;try{[void][IntentArc.PreflightEnvelope.BoundaryGuard]::OpenFile(" + quote(fixture.root) + "," + quote(fixture.root) + ")}catch{$directoryAsFile=$true}",
        "$finalMismatch=$false;try{[void][IntentArc.PreflightEnvelope.BoundaryGuard]::OpenFile(" + quote(fixture.paths.controller) + "," + quote(fixture.paths.controller + ".wrong") + ")}catch{$finalMismatch=$true}",
        "$reparseAncestor=$false;try{[void][IntentArc.PreflightEnvelope.BoundaryGuard]::OpenFile(" + quote(aliasedFile) + "," + quote(aliasedFile) + ")}catch{$reparseAncestor=$true}",
        "[ordered]@{fileAsDirectory=$fileAsDirectory;directoryAsFile=$directoryAsFile;finalMismatch=$finalMismatch;reparseAncestor=$reparseAncestor}|ConvertTo-Json -Compress",
      ].join("\n");
      expect(await runBoundaryHarness(body)).toEqual({ fileAsDirectory: true, directoryAsFile: true, finalMismatch: true, reparseAncestor: true });
    } finally { await rmdir(alias).catch(() => undefined); await rm(aliasParent, { recursive: true, force: true }); await disposeFixture(fixture); }
  });

  it("rejects a final-component file symlink in the boundary guard", async (context) => {
    const fixture = await createFixture(); const symlinkPath = join(fixture.root, "boundary symlink.ps1");
    try {
      try { await symlink(fixture.paths.controller, symlinkPath, "file"); }
      catch (error) {
        if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) { context.skip(); return; }
        throw error;
      }
      const body = `$rejected=$false;try{[void][IntentArc.PreflightEnvelope.BoundaryGuard]::OpenFile(${quote(symlinkPath)},${quote(symlinkPath)})}catch{$rejected=$true};[ordered]@{rejected=$rejected}|ConvertTo-Json -Compress`;
      expect(await runBoundaryHarness(body)).toEqual({ rejected: true });
    } finally { await rm(symlinkPath, { force: true }); await disposeFixture(fixture); }
  });

  it("retains ancestor and leaf no-delete-share handles until boundary disposal", async () => {
    const fixture = await createFixture();
    try {
      const ancestor = join(fixture.root, "guarded parent"); const leaf = join(ancestor, "guarded.txt");
      const body = [
        `New-Item -ItemType Directory -Path ${quote(ancestor)} -ErrorAction Stop|Out-Null`,
        `[IO.File]::WriteAllText(${quote(leaf)},'guarded')`,
        `$guard=[IntentArc.PreflightEnvelope.BoundaryGuard]::OpenFile(${quote(leaf)},${quote(leaf)})`,
        `$leafBlocked=$false;try{Move-Item -LiteralPath ${quote(leaf)} -Destination ${quote(leaf + ".moved")} -ErrorAction Stop}catch{$leafBlocked=$true}`,
        `$writeBlocked=$false;try{[IO.File]::WriteAllText(${quote(leaf)},'changed')}catch{$writeBlocked=$true}`,
        `$ancestorBlocked=$false;try{Move-Item -LiteralPath ${quote(ancestor)} -Destination ${quote(ancestor + ".moved")} -ErrorAction Stop}catch{$ancestorBlocked=$true}`,
        "$stillValid=$guard.Revalidate();$guard.Dispose()",
        `Move-Item -LiteralPath ${quote(leaf)} -Destination ${quote(leaf + ".moved")} -ErrorAction Stop`,
        `Move-Item -LiteralPath ${quote(ancestor)} -Destination ${quote(ancestor + ".moved")} -ErrorAction Stop`,
        "[ordered]@{leafBlocked=$leafBlocked;writeBlocked=$writeBlocked;ancestorBlocked=$ancestorBlocked;stillValid=$stillValid;released=$true}|ConvertTo-Json -Compress",
      ].join("\n");
      expect(await runBoundaryHarness(body)).toEqual({ leafBlocked: true, writeBlocked: true, ancestorBlocked: true, stillValid: true, released: true });
    } finally { await disposeFixture(fixture); }
  });

  it("opens an out sentinel with attributes only and never reads a locked child", async () => {
    const fixture = await createFixture();
    try {
      const out = join(fixture.root, "out");
      const body = [
        `New-Item -ItemType Directory -Path ${quote(out)} -ErrorAction Stop|Out-Null`,
        `$child=Join-Path ${quote(out)} 'opaque.bin';[IO.File]::WriteAllBytes($child,[byte[]](1,2,3));$lease=[IO.File]::Open($child,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)`,
        "try {$guard=[IntentArc.PreflightEnvelope.BoundaryGuard]::OpenDirectory(" + quote(out) + "," + quote(out) + ");try{$opened=$guard.Revalidate()}finally{$guard.Dispose()}}finally{$lease.Dispose()}",
        "[ordered]@{opened=$opened}|ConvertTo-Json -Compress",
      ].join("\n");
      expect(await runBoundaryHarness(body)).toEqual({ opened: true });
    } finally { await disposeFixture(fixture); }
  });

  it("distinguishes absent, present, and indeterminate Job probes", async () => {
    const body = [
      "Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;using System.Security.Principal;namespace IntentArc.Task2Fixture{public sealed class JobLease:IDisposable{[StructLayout(LayoutKind.Sequential)]struct SA{public int Length;public IntPtr Descriptor;public bool Inherit;}[DllImport(\"kernel32.dll\",CharSet=CharSet.Unicode,SetLastError=true,EntryPoint=\"CreateJobObjectW\")]static extern IntPtr CreateDefault(IntPtr a,string n);[DllImport(\"kernel32.dll\",CharSet=CharSet.Unicode,SetLastError=true,EntryPoint=\"CreateJobObjectW\")]static extern IntPtr CreateSecured(ref SA a,string n);[DllImport(\"advapi32.dll\",CharSet=CharSet.Unicode,SetLastError=true,EntryPoint=\"ConvertStringSecurityDescriptorToSecurityDescriptorW\")]static extern bool Convert(string s,uint r,out IntPtr d,out uint z);[DllImport(\"kernel32.dll\")]static extern IntPtr LocalFree(IntPtr p);[DllImport(\"kernel32.dll\")]static extern bool CloseHandle(IntPtr h);IntPtr h;public JobLease(string n,bool denyQuery){IntPtr d=IntPtr.Zero;if(denyQuery){string sid=WindowsIdentity.GetCurrent().User.Value;uint z;if(!Convert(\"D:P(D;;0x4;;;\"+sid+\")(A;;GA;;;\"+sid+\")(A;;GA;;;SY)(A;;GA;;;BA)\",1,out d,out z))throw new InvalidOperationException();SA a=new SA{Length=Marshal.SizeOf(typeof(SA)),Descriptor=d,Inherit=false};h=CreateSecured(ref a,n);}else h=CreateDefault(IntPtr.Zero,n);if(d!=IntPtr.Zero)LocalFree(d);if(h==IntPtr.Zero)throw new InvalidOperationException();}public void Dispose(){if(h!=IntPtr.Zero){CloseHandle(h);h=IntPtr.Zero;}}}}'",
      "$name='Local\\IntentArc.Task2.'+[Guid]::NewGuid().ToString('N')",
      "$absent=[IntentArc.PreflightEnvelope.JobProbe]::Probe($name).ToString();$lease=[IntentArc.Task2Fixture.JobLease]::new($name,$false)",
      "try{$present=[IntentArc.PreflightEnvelope.JobProbe]::Probe($name).ToString()}finally{$lease.Dispose()}",
      "$deniedName='Local\\IntentArc.Task2.Denied.'+[Guid]::NewGuid().ToString('N');$deniedLease=[IntentArc.Task2Fixture.JobLease]::new($deniedName,$true);try{$denied=[IntentArc.PreflightEnvelope.JobProbe]::Probe($deniedName).ToString()}finally{$deniedLease.Dispose()}",
      "$indeterminate=[IntentArc.PreflightEnvelope.JobProbe]::Probe(([string][char]0)).ToString()",
      "[ordered]@{absent=$absent;present=$present;denied=$denied;indeterminate=$indeterminate}|ConvertTo-Json -Compress",
    ].join("\n");
    expect(await runBoundaryHarness(body)).toEqual({ absent: "Absent", present: "Present", denied: "Indeterminate", indeterminate: "Indeterminate" });
  });

  it("distinguishes active, absent, reused, and indeterminate process probes", async () => {
    const body = [
      "$process=[Diagnostics.Process]::GetCurrentProcess();$pidValue=$process.Id;$start=$process.StartTime.ToUniversalTime().ToFileTimeUtc()",
      "$active=[IntentArc.PreflightEnvelope.ProcessProbe]::Probe($pidValue,$start).ToString()",
      "$reused=[IntentArc.PreflightEnvelope.ProcessProbe]::Probe($pidValue,($start+1)).ToString()",
      "$absent=[IntentArc.PreflightEnvelope.ProcessProbe]::Probe(2147483647,1).ToString()",
      "$denied=[IntentArc.PreflightEnvelope.ProcessProbe]::Probe(4,1).ToString()",
      "$indeterminate=[IntentArc.PreflightEnvelope.ProcessProbe]::Probe(-1,0).ToString()",
      "[ordered]@{active=$active;reused=$reused;absent=$absent;denied=$denied;indeterminate=$indeterminate}|ConvertTo-Json -Compress",
    ].join("\n");
    expect(await runBoundaryHarness(body)).toEqual({ active: "Present", reused: "Absent", absent: "Absent", denied: "Indeterminate", indeterminate: "Indeterminate" });
  });

  it("creates a protected root exclusively and rejects collisions and unsafe direct children", async () => {
    const fixture = await createFixture();
    try {
      const parent = join(fixture.root, "evidence parent");
      const body = [
        `New-Item -ItemType Directory -Path ${quote(parent)} -ErrorAction Stop|Out-Null`,
        `$root=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::CreateExclusiveRoot(${quote(parent)},'attempt')`,
        `$parentGuard=[IntentArc.PreflightEnvelope.BoundaryGuard]::OpenDirectory(${quote(parent)},${quote(parent)});try{$parentProtected=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::ValidateProtection($parentGuard)}finally{$parentGuard.Dispose()}`,
        "$collision=$false;try{[void][IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::CreateExclusiveRoot(" + quote(parent) + ",'attempt')}catch{$collision=$true}",
        "$escape=$false;try{[void][IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::WriteAtomicNew($root,'..\\escape.json',[Text.Encoding]::UTF8.GetBytes('x'))}catch{$escape=$true}",
        "$protected=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::ValidateProtection($root)",
        "$root.Dispose();[ordered]@{collision=$collision;escape=$escape;parentProtected=$parentProtected;protected=$protected}|ConvertTo-Json -Compress",
      ].join("\n");
      expect(await runBoundaryHarness(body)).toEqual({ collision: true, escape: true, parentProtected: true, protected: true });
    } finally { await disposeFixture(fixture); }
  });

  it("atomically creates, flushes, reopens, hashes, protects, and cleans temporary evidence", async () => {
    const fixture = await createFixture();
    try {
      const parent = join(fixture.root, "atomic parent"); const text = '{"state":"created"}';
      const body = [
        `New-Item -ItemType Directory -Path ${quote(parent)} -ErrorAction Stop|Out-Null`,
        `$root=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::CreateExclusiveRoot(${quote(parent)},'attempt')`,
        `$bytes=[Text.Encoding]::UTF8.GetBytes(${quote(text)});$file=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::WriteAtomicNew($root,'authorization.json',$bytes)`,
        "try{$roundTrip=[Text.Encoding]::UTF8.GetString($file.ReadAllBytes(4096));$identity=$file.StableIdentity;$protected=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::ValidateProtection($file)}finally{$file.Dispose()}",
        "$collision=$false;try{[void][IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::WriteAtomicNew($root,'authorization.json',$bytes)}catch{$collision=$true}",
        "$temporaryCount=@(Get-ChildItem -LiteralPath " + quote(join(parent, "attempt")) + " -Force|Where-Object{$_.Name -like '*.tmp'}).Count",
        "$root.Dispose();[ordered]@{roundTrip=$roundTrip;identity=$identity;protected=$protected;collision=$collision;temporaryCount=$temporaryCount}|ConvertTo-Json -Compress",
      ].join("\n");
      expect(await runBoundaryHarness(body)).toEqual({ roundTrip: text, identity: expect.stringMatching(/^[0-9a-f]{8}:[0-9a-f]{16}$/), protected: true, collision: true, temporaryCount: 0 });
    } finally { await disposeFixture(fixture); }
  });

  it("offers only exclusive immutable protected evidence creation for both launch journals", async () => {
    const fixture = await createFixture();
    try {
      const parent = join(fixture.root, "immutable journals parent");
      const consumed = '{"schema":"intentarc.preflight-execution-consumed/v1","controllerLaunchStatus":"attempted"}';
      const started = '{"schema":"intentarc.preflight-execution-controller-started/v1","controllerProcessId":123}';
      const body = [
        `New-Item -ItemType Directory -Path ${quote(parent)} -ErrorAction Stop|Out-Null`,
        `$root=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::CreateExclusiveRoot(${quote(parent)},'attempt')`,
        "$flags=[Reflection.BindingFlags]::Public -bor [Reflection.BindingFlags]::Static -bor [Reflection.BindingFlags]::DeclaredOnly",
        "$methods=@([IntentArc.PreflightEnvelope.ProtectedEvidenceStore].GetMethods($flags)|ForEach-Object Name|Sort-Object -Unique)",
        `$consumedBytes=[Text.Encoding]::UTF8.GetBytes(${quote(consumed)});$startedBytes=[Text.Encoding]::UTF8.GetBytes(${quote(started)})`,
        "$consumedFile=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::WriteAtomicNew($root,'consumed.json',$consumedBytes)",
        "$startedFile=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::WriteAtomicNew($root,'controller-started.json',$startedBytes)",
        "try{$consumedProtected=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::ValidateProtection($consumedFile);$startedProtected=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::ValidateProtection($startedFile)}finally{$consumedFile.Dispose();$startedFile.Dispose()}",
        "$consumedCollision=$false;try{[void][IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::WriteAtomicNew($root,'consumed.json',$startedBytes)}catch{$consumedCollision=$true}",
        "$startedCollision=$false;try{[void][IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::WriteAtomicNew($root,'controller-started.json',$consumedBytes)}catch{$startedCollision=$true}",
        "$root.Dispose();[ordered]@{methods=$methods;consumedProtected=$consumedProtected;startedProtected=$startedProtected;consumedCollision=$consumedCollision;startedCollision=$startedCollision;consumed=[IO.File]::ReadAllText(" + quote(join(parent, "attempt", "consumed.json")) + ");started=[IO.File]::ReadAllText(" + quote(join(parent, "attempt", "controller-started.json")) + ")}|ConvertTo-Json -Compress",
      ].join("\n");
      expect(await runBoundaryHarness(body)).toEqual({
        methods: ["CreateExclusiveRoot", "OpenValidated", "ValidateProtection", "WriteAtomicNew"],
        consumedProtected: true, startedProtected: true, consumedCollision: true, startedCollision: true,
        consumed, started,
      });
    } finally { await disposeFixture(fixture); }
  });

  it("keeps a returned immutable journal pinned without write sharing until its guard is disposed", async () => {
    const fixture = await createFixture();
    try {
      const parent = join(fixture.root, "pinned immutable writer parent"); const destination = join(parent, "attempt", "consumed.json");
      const candidate = '{"controllerLaunchStatus":"attempted"}';
      const body = [
        "Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;using Microsoft.Win32.SafeHandles;namespace IntentArc.Task2WriterProbe{public static class Probe{[DllImport(\"kernel32.dll\",CharSet=CharSet.Unicode,SetLastError=true)]static extern SafeFileHandle CreateFile(string path,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);public static bool TryOpenDirectory(string path){using(SafeFileHandle handle=CreateFile(path,0x40000000u,7u,IntPtr.Zero,3u,0x02200000u,IntPtr.Zero)){return !handle.IsInvalid;}}}}'",
        `New-Item -ItemType Directory -Path ${quote(parent)} -ErrorAction Stop|Out-Null`,
        `$root=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::CreateExclusiveRoot(${quote(parent)},'attempt')`,
        `$rootWriterOpened=[IntentArc.Task2WriterProbe.Probe]::TryOpenDirectory(${quote(join(parent, "attempt"))})`,
        `$file=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::WriteAtomicNew($root,'consumed.json',[Text.Encoding]::UTF8.GetBytes(${quote(candidate)}))`,
        "$writer=$null;$writerOpened=$false;try{$writer=[IO.File]::Open(" + quote(destination) + ",[IO.FileMode]::Open,[IO.FileAccess]::Write,([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete));$writerOpened=$true;$tampered=[Text.Encoding]::UTF8.GetBytes('tampered');$writer.SetLength(0);$writer.Write($tampered,0,$tampered.Length);$writer.Flush($true)}catch [IO.IOException]{}catch [UnauthorizedAccessException]{}finally{if($null-ne$writer){$writer.Dispose()}}",
        "$actual=[Text.Encoding]::UTF8.GetString($file.ReadAllBytes(4096));$stillValid=$file.Revalidate();$file.Dispose();$root.Dispose()",
        "[ordered]@{rootWriterOpened=$rootWriterOpened;writerOpened=$writerOpened;actual=$actual;stillValid=$stillValid}|ConvertTo-Json -Compress",
      ].join("\n");
      expect(await runBoundaryHarness(body)).toEqual({ rootWriterOpened: true, writerOpened: false, actual: candidate, stillValid: true });
    } finally { await disposeFixture(fixture); }
  });

  it("creates the attempt root relative to its retained parent and keeps that identity pinned through admission", async () => {
    const fixture = await createFixture();
    try {
      const reviewedPath = join(fixture.root, "reviewed retained root parent.ps1");
      const parent = join(fixture.root, "retained root parent"); const attempt = join(parent, "attempt"); const moved = join(parent, "moved-attempt");
      const source = await readFile(scriptPath, "utf8");
      const vulnerableNeedle = "      BoundaryGuard root = BoundaryGuard.OpenDirectory(rootPath, rootPath);";
      const anchoredNeedle = "        root = BoundaryGuard.CreateDirectoryRelative(parent, leaf, rootPath, descriptor);";
      const hook = "        foreach (System.Reflection.Assembly candidateAssembly in AppDomain.CurrentDomain.GetAssemblies()) { Type candidateType = candidateAssembly.GetType(\"IntentArc.Task2Durability.RootRace\"); if (candidateType != null) { candidateType.GetMethod(\"Attempt\").Invoke(null, null); break; } }";
      const instrumented = source.includes(vulnerableNeedle)
        ? source.replace(vulnerableNeedle, `${hook}\n${vulnerableNeedle}`)
        : source.replace(anchoredNeedle, `${anchoredNeedle}\n${hook}`);
      expect(instrumented).not.toBe(source); await writeFile(reviewedPath, instrumented, "utf8");
      const body = [
        "Add-Type -TypeDefinition 'using System;using System.IO;namespace IntentArc.Task2Durability{public static class RootRace{public static string AttemptPath;public static string MovedPath;public static bool Attempted;public static bool Replaced;public static void Attempt(){Attempted=true;try{Directory.Move(AttemptPath,MovedPath);Directory.CreateDirectory(AttemptPath);Replaced=true;}catch(IOException){}catch(UnauthorizedAccessException){}}}}'",
        `New-Item -ItemType Directory -Path ${quote(parent)} -ErrorAction Stop|Out-Null`,
        `[IntentArc.Task2Durability.RootRace]::AttemptPath=${quote(attempt)};[IntentArc.Task2Durability.RootRace]::MovedPath=${quote(moved)}`,
        `$failed=$false;$root=$null;try{$root=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::CreateExclusiveRoot(${quote(parent)},'attempt')}catch{$failed=$true}`,
        "$protected=$false;if($null-ne$root){$protected=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::ValidateProtection($root);$root.Dispose()}",
        `[ordered]@{attempted=[IntentArc.Task2Durability.RootRace]::Attempted;replaced=[IntentArc.Task2Durability.RootRace]::Replaced;failed=$failed;protected=$protected;moved=[IntentArc.PreflightEnvelope.EntryProbe]::Probe(${quote(moved)}).ToString()}|ConvertTo-Json -Compress`,
      ].join("\n");
      expect(await runBoundaryHarness(body, reviewedPath)).toEqual({ attempted: true, replaced: false, failed: false, protected: true, moved: "Absent" });
    } finally { await disposeFixture(fixture); }
  });

  it("identity-cleans a relative temporary when guard construction fails, including during a root-reparse attempt", async () => {
    const fixture = await createFixture();
    try {
      const reviewedPath = join(fixture.root, "reviewed temporary guard construction.ps1");
      const parent = join(fixture.root, "temporary guard parent"); const attempt = join(parent, "attempt"); const moved = join(parent, "moved-attempt");
      const source = await readFile(scriptPath, "utf8");
      const needle = "            suppliedLeaf = null;";
      const hook = "            foreach (System.Reflection.Assembly candidateAssembly in AppDomain.CurrentDomain.GetAssemblies()) { Type candidateType = candidateAssembly.GetType(\"IntentArc.Task2Durability.GuardFault\"); if (candidateType != null) { candidateType.GetMethod(\"BeforeLeafValidation\").Invoke(null, new object[] { path }); break; } }";
      const instrumented = source.replace(needle, `${needle}\n${hook}`);
      expect(instrumented).not.toBe(source); await writeFile(reviewedPath, instrumented, "utf8");
      const body = [
        "Add-Type -TypeDefinition 'using System;using System.IO;using System.Runtime.InteropServices;namespace IntentArc.Task2Durability{public static class GuardFault{[DllImport(\"kernel32.dll\",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool CreateSymbolicLink(string link,string target,uint flags);public static string AttemptPath;public static string MovedPath;public static bool Trigger;public static bool ReplacementAttempted;public static bool ReparseCreated;public static void BeforeLeafValidation(string path){if(!Trigger||!path.EndsWith(\".tmp\",StringComparison.OrdinalIgnoreCase))return;ReplacementAttempted=true;try{Directory.Move(AttemptPath,MovedPath);ReparseCreated=CreateSymbolicLink(AttemptPath,MovedPath,1u);}catch(IOException){}catch(UnauthorizedAccessException){}throw new InvalidOperationException(\"fixture-constructor-fault\");}}}'",
        `New-Item -ItemType Directory -Path ${quote(parent)} -ErrorAction Stop|Out-Null`,
        `$root=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::CreateExclusiveRoot(${quote(parent)},'attempt')`,
        `[IntentArc.Task2Durability.GuardFault]::AttemptPath=${quote(attempt)};[IntentArc.Task2Durability.GuardFault]::MovedPath=${quote(moved)};[IntentArc.Task2Durability.GuardFault]::Trigger=$true`,
        "$rejected=$false;try{[void][IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::WriteAtomicNew($root,'consumed.json',[Text.Encoding]::UTF8.GetBytes('x'))}catch{$rejected=$true}",
        "$root.Dispose()",
        `[ordered]@{rejected=$rejected;replacementAttempted=[IntentArc.Task2Durability.GuardFault]::ReplacementAttempted;reparseCreated=[IntentArc.Task2Durability.GuardFault]::ReparseCreated;temporaryCount=@(Get-ChildItem -LiteralPath ${quote(attempt)} -Force|Where-Object{$_.Name -like '*.tmp'}).Count}|ConvertTo-Json -Compress`,
      ].join("\n");
      expect(await runBoundaryHarness(body, reviewedPath)).toEqual({ rejected: true, replacementAttempted: true, reparseCreated: false, temporaryCount: 0 });
    } finally { await disposeFixture(fixture); }
  });

  it("durably flushes protected root and journal namespace state and fails closed after a post-rename fault", async () => {
    const fixture = await createFixture();
    try {
      const reviewedPath = join(fixture.root, "reviewed durable journal.ps1");
      const parent = join(fixture.root, "durable journal parent"); const attempt = join(parent, "attempt"); const destination = join(attempt, "consumed.json");
      const source = await readFile(scriptPath, "utf8");
      expect(source).toContain("NtCreateFile");
      expect(source).toMatch(/FileWriteThrough\s*=\s*0x00000002u/);
      const needle = "    internal void FlushDurable() {";
      const hook = "      foreach (System.Reflection.Assembly candidateAssembly in AppDomain.CurrentDomain.GetAssemblies()) { Type candidateType = candidateAssembly.GetType(\"IntentArc.Task2Durability.FlushFault\"); if (candidateType != null) { candidateType.GetMethod(\"Observe\").Invoke(null, new object[] { CanonicalPath }); break; } }";
      const instrumented = source.replace(needle, `${needle}\n${hook}`);
      expect(instrumented).not.toBe(source); await writeFile(reviewedPath, instrumented, "utf8");
      const candidate = '{"controllerLaunchStatus":"attempted"}';
      const body = [
        "Add-Type -TypeDefinition 'using System;using System.Collections.Generic;namespace IntentArc.Task2Durability{public static class FlushFault{public static readonly List<string> Paths=new List<string>();public static string FailSuffix;public static void Observe(string path){Paths.Add(path);if(!String.IsNullOrEmpty(FailSuffix)&&path.EndsWith(FailSuffix,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException(\"fixture-host-loss\");}}}'",
        `New-Item -ItemType Directory -Path ${quote(parent)} -ErrorAction Stop|Out-Null`,
        `$root=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::CreateExclusiveRoot(${quote(parent)},'attempt')`,
        "[IntentArc.Task2Durability.FlushFault]::FailSuffix='.tmp'",
        "$temporaryRejected=$false;try{[void][IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::WriteAtomicNew($root,'temporary-fault.json',[Text.Encoding]::UTF8.GetBytes('temporary'))}catch{$temporaryRejected=$true}",
        `$temporaryDisposition=[IntentArc.PreflightEnvelope.EntryProbe]::Probe(${quote(join(attempt, "temporary-fault.json"))}).ToString();[IntentArc.Task2Durability.FlushFault]::FailSuffix=$null`,
        `[IntentArc.Task2Durability.FlushFault]::FailSuffix='consumed.json'`,
        `$rejected=$false;try{[void][IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::WriteAtomicNew($root,'consumed.json',[Text.Encoding]::UTF8.GetBytes(${quote(candidate)}))}catch{$rejected=$true}`,
        "[IntentArc.Task2Durability.FlushFault]::FailSuffix=$null",
        "$opened=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::OpenValidated($root,'consumed.json',4096);try{$actual=[Text.Encoding]::UTF8.GetString($opened.ReadAllBytes(4096));$protected=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::ValidateProtection($opened)}finally{$opened.Dispose()}",
        "[IntentArc.Task2Durability.FlushFault]::FailSuffix='attempt'",
        "$rootRejected=$false;try{[void][IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::WriteAtomicNew($root,'root-fault.json',[Text.Encoding]::UTF8.GetBytes('root-fault'))}catch{$rootRejected=$true};[IntentArc.Task2Durability.FlushFault]::FailSuffix=$null",
        "$rootFault=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::OpenValidated($root,'root-fault.json',4096);try{$rootFaultProtected=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::ValidateProtection($rootFault)}finally{$rootFault.Dispose()}",
        "$started=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::WriteAtomicNew($root,'controller-started.json',[Text.Encoding]::UTF8.GetBytes('started'));$started.Dispose()",
        `$paths=@([IntentArc.Task2Durability.FlushFault]::Paths);$root.Dispose();[ordered]@{temporaryRejected=$temporaryRejected;temporaryDisposition=$temporaryDisposition;rejected=$rejected;actual=$actual;protected=$protected;rootRejected=$rootRejected;rootFaultProtected=$rootFaultProtected;parentFlushes=@($paths|Where-Object{$_ -eq ${quote(`\\\\?\\${parent}`)}}).Count;rootFlushes=@($paths|Where-Object{$_ -eq ${quote(`\\\\?\\${attempt}`)}}).Count;temporaryFlushes=@($paths|Where-Object{$_ -like '*.tmp'}).Count;destinationFlushes=@($paths|Where-Object{$_ -eq ${quote(`\\\\?\\${destination}`)}}).Count}|ConvertTo-Json -Compress`,
      ].join("\n");
      expect(await runBoundaryHarness(body, reviewedPath)).toEqual({ temporaryRejected: true, temporaryDisposition: "Absent", rejected: true, actual: candidate, protected: true, rootRejected: true, rootFaultProtected: true, parentFlushes: 2, rootFlushes: 3, temporaryFlushes: 7, destinationFlushes: 1 });
    } finally { await disposeFixture(fixture); }
  });

  it("exposes only PowerShell-required native calls and keeps raw filesystem mutators non-public", async () => {
    const body = [
      "$type=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore].Assembly.GetType('IntentArc.PreflightEnvelope.Native')",
      "$flags=[Reflection.BindingFlags]::Public -bor [Reflection.BindingFlags]::Static -bor [Reflection.BindingFlags]::DeclaredOnly",
      "$methods=@($type.GetMethods($flags)|ForEach-Object Name|Sort-Object -Unique)",
      "[ordered]@{typePublic=$type.IsPublic;methods=$methods}|ConvertTo-Json -Compress",
    ].join("\n");
    expect(await runBoundaryHarness(body)).toEqual({ typePublic: true, methods: ["CommandLineToArgvW", "GetCommandLineW", "LocalFree", "QueryFullProcessImageNameW"] });
  });

  it("kills relative-create, constructor-cleanup, durability, and native-surface source mutants", async () => {
    const source = await readFile(scriptPath, "utf8");
    expect(durableBoundaryViolations(source)).toEqual([]);
    const mutants = [
      source.replace("uint options = FileWriteThrough |", "uint options = 0u |"),
      source.replace("        parent.FlushDurable();", "        // mutant omitted parent flush"),
      source.replace("        root.FlushDurable();", "        // mutant omitted root flush"),
      source.replace("        root.FlushDurable();\n        parent.FlushDurable();", "        root.FlushDurable();\n        // mutant omitted parent namespace flush"),
      source.replace("        guard.FlushDurable();", "        // mutant omitted protected temporary flush"),
      source.replace("        temporaryGuard.FlushDurable();", "        // mutant omitted renamed file flush"),
      source.replace("        temporaryGuard.FlushDurable();\n        root.FlushDurable();", "        temporaryGuard.FlushDurable();\n        // mutant omitted journal namespace flush"),
      source.replace("root = BoundaryGuard.CreateDirectoryRelative(parent, leaf, rootPath, descriptor);", "root = BoundaryGuard.OpenDirectory(rootPath, rootPath);"),
      source.replace("guard = BoundaryGuard.CreateFileRelative(root, leaf, path, descriptor);", "guard = BoundaryGuard.OpenFileForMutation(path, path);"),
      source.replace("createDirectory ? ShareRead | ShareWrite : ShareRead, FileCreate", "ShareRead | ShareWrite, FileCreate"),
      source.replace("MarkDelete(createdLeaf.DangerousGetHandle())", "MarkDelete(IntPtr.Zero)"),
      source.replace("internal static extern uint SetSecurityInfo", "public static extern uint SetSecurityInfo"),
    ];
    expect(mutants).toHaveLength(12);
    for (const mutant of mutants) {
      expect(mutant).not.toBe(source);
      expect(durableBoundaryViolations(mutant)).not.toEqual([]);
    }
  });

  it("contains no mutable, replacement, transactional, or in-place protected evidence path", async () => {
    expect(immutableEvidenceViolations(await readFile(scriptPath, "utf8"))).toEqual([]);
  });

  it("preserves a competing immutable leaf and cleans its temporary when exclusive promotion loses a race", async () => {
    const fixture = await createFixture();
    try {
      const reviewedPath = join(fixture.root, "reviewed exclusive leaf race.ps1");
      const parent = join(fixture.root, "exclusive leaf race parent"); const destination = join(parent, "attempt", "consumed.json");
      const source = await readFile(scriptPath, "utf8");
      const needle = "        PromoteBoundIdentity(root, temporaryGuard, temporary, leaf);";
      const hook = "        foreach (System.Reflection.Assembly candidateAssembly in AppDomain.CurrentDomain.GetAssemblies()) { Type candidateType = candidateAssembly.GetType(\"IntentArc.Task2Immutable.LeafRace\"); if (candidateType != null) { candidateType.GetMethod(\"Create\").Invoke(null, null); break; } }";
      const instrumented = source.replace(needle, `${hook}\n${needle}`);
      expect(instrumented).not.toBe(source); await writeFile(reviewedPath, instrumented, "utf8");
      const candidate = '{"controllerLaunchStatus":"attempted"}'; const competing = "competing-immutable-entry";
      const body = [
        "Add-Type -TypeDefinition 'using System;using System.IO;namespace IntentArc.Task2Immutable{public static class LeafRace{public static string Destination;public static string Competing;public static bool Created;public static void Create(){try{using(FileStream stream=new FileStream(Destination,FileMode.CreateNew,FileAccess.Write,FileShare.Read)){byte[] bytes=System.Text.Encoding.UTF8.GetBytes(Competing);stream.Write(bytes,0,bytes.Length);stream.Flush(true);}Created=true;}catch(IOException){}}}}'",
        `New-Item -ItemType Directory -Path ${quote(parent)} -ErrorAction Stop|Out-Null`,
        `$root=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::CreateExclusiveRoot(${quote(parent)},'attempt')`,
        `[IntentArc.Task2Immutable.LeafRace]::Destination=${quote(destination)};[IntentArc.Task2Immutable.LeafRace]::Competing=${quote(competing)}`,
        `$rejected=$false;try{[void][IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::WriteAtomicNew($root,'consumed.json',[Text.Encoding]::UTF8.GetBytes(${quote(candidate)}))}catch{$rejected=$true}`,
        `$temporaryCount=@(Get-ChildItem -LiteralPath ${quote(join(parent, "attempt"))} -Force|Where-Object{$_.Name -like '*.tmp'}).Count;$root.Dispose()`,
        `[ordered]@{created=[IntentArc.Task2Immutable.LeafRace]::Created;rejected=$rejected;preserved=[IO.File]::ReadAllText(${quote(destination)});temporaryCount=$temporaryCount}|ConvertTo-Json -Compress`,
      ].join("\n");
      expect(await runBoundaryHarness(body, reviewedPath)).toEqual({ created: true, rejected: true, preserved: competing, temporaryCount: 0 });
    } finally { await disposeFixture(fixture); }
  });

  it("keeps the validated parent chain pinned while exclusively promoting immutable evidence", async () => {
    const fixture = await createFixture();
    try {
      const reviewedPath = join(fixture.root, "reviewed exclusive parent race.ps1");
      const parent = join(fixture.root, "exclusive parent race parent"); const attempt = join(parent, "attempt"); const moved = join(parent, "moved-attempt");
      const source = await readFile(scriptPath, "utf8");
      const needle = "        PromoteBoundIdentity(root, temporaryGuard, temporary, leaf);";
      const hook = "        foreach (System.Reflection.Assembly candidateAssembly in AppDomain.CurrentDomain.GetAssemblies()) { Type candidateType = candidateAssembly.GetType(\"IntentArc.Task2Immutable.ParentRace\"); if (candidateType != null) { candidateType.GetMethod(\"Attempt\").Invoke(null, null); break; } }";
      const instrumented = source.replace(needle, `${hook}\n${needle}`);
      expect(instrumented).not.toBe(source); await writeFile(reviewedPath, instrumented, "utf8");
      const candidate = '{"controllerLaunchStatus":"attempted"}';
      const body = [
        "Add-Type -TypeDefinition 'using System;using System.IO;namespace IntentArc.Task2Immutable{public static class ParentRace{public static string Parent;public static string Moved;public static bool Attempted;public static bool Replaced;public static void Attempt(){Attempted=true;try{Directory.Move(Parent,Moved);Directory.CreateDirectory(Parent);Replaced=true;}catch(IOException){}catch(UnauthorizedAccessException){}}}}'",
        `New-Item -ItemType Directory -Path ${quote(parent)} -ErrorAction Stop|Out-Null`,
        `$root=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::CreateExclusiveRoot(${quote(parent)},'attempt')`,
        `[IntentArc.Task2Immutable.ParentRace]::Parent=${quote(attempt)};[IntentArc.Task2Immutable.ParentRace]::Moved=${quote(moved)}`,
        `$file=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::WriteAtomicNew($root,'consumed.json',[Text.Encoding]::UTF8.GetBytes(${quote(candidate)}));try{$actual=[Text.Encoding]::UTF8.GetString($file.ReadAllBytes(4096))}finally{$file.Dispose();$root.Dispose()}`,
        `[ordered]@{attempted=[IntentArc.Task2Immutable.ParentRace]::Attempted;replaced=[IntentArc.Task2Immutable.ParentRace]::Replaced;actual=$actual;temporaryCount=@(Get-ChildItem -LiteralPath ${quote(attempt)} -Force|Where-Object{$_.Name -like '*.tmp'}).Count}|ConvertTo-Json -Compress`,
      ].join("\n");
      expect(await runBoundaryHarness(body, reviewedPath)).toEqual({ attempted: true, replaced: false, actual: candidate, temporaryCount: 0 });
    } finally { await disposeFixture(fixture); }
  });

  it("rejects unprotected evidence while preserving immutable protected bytes", async () => {
    const fixture = await createFixture();
    try {
      const parent = join(fixture.root, "immutable validation parent"); const consumed = '{"controllerLaunchStatus":"attempted"}';
      const body = [
        `New-Item -ItemType Directory -Path ${quote(parent)} -ErrorAction Stop|Out-Null`,
        `$root=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::CreateExclusiveRoot(${quote(parent)},'attempt')`,
        `$bytes=[Text.Encoding]::UTF8.GetBytes(${quote(consumed)});$file=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::WriteAtomicNew($root,'consumed.json',$bytes);$file.Dispose()`,
        "$opened=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::OpenValidated($root,'consumed.json',4096);try{$preserved=[Text.Encoding]::UTF8.GetString($opened.ReadAllBytes(4096))}finally{$opened.Dispose()}",
        `[IO.File]::WriteAllText((Join-Path ${quote(join(parent, "attempt"))} 'unprotected.json'),'x')`,
        "$unprotected=$false;try{[void][IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::OpenValidated($root,'unprotected.json',4096)}catch{$unprotected=$true}",
        "$root.Dispose();[ordered]@{preserved=$preserved;unprotected=$unprotected}|ConvertTo-Json -Compress",
      ].join("\n");
      expect(await runBoundaryHarness(body)).toEqual({ preserved: consumed, unprotected: true });
    } finally { await disposeFixture(fixture); }
  });

  it("keeps the protected parent identity pinned across owner and DACL mutation", async () => {
    const fixture = await createFixture();
    try {
      const reviewedPath = join(fixture.root, "reviewed parent protection.ps1");
      const parent = join(fixture.root, "protected parent race"); const moved = join(fixture.root, "displaced parent");
      const source = await readFile(scriptPath, "utf8");
      const vulnerableNeedle = "        parent.Dispose();\n        ApplyProtectionPath(parentPath, true);";
      const pinnedNeedle = "          ApplyProtection(parent.LeafHandle, true);";
      const hook = "        foreach (System.Reflection.Assembly candidateAssembly in AppDomain.CurrentDomain.GetAssemblies()) { Type candidateType = candidateAssembly.GetType(\"IntentArc.Task2Review.ParentReplacement\"); if (candidateType != null) { candidateType.GetMethod(\"Attempt\").Invoke(null, null); break; } }";
      const instrumented = source.includes(vulnerableNeedle)
        ? source.replace(vulnerableNeedle, `        parent.Dispose();\n${hook}\n        ApplyProtectionPath(parentPath, true);`)
        : source.replace(pinnedNeedle, `${hook}\n${pinnedNeedle}`);
      expect(instrumented).not.toBe(source); await writeFile(reviewedPath, instrumented, "utf8");
      const body = [
        "Add-Type -TypeDefinition 'using System;using System.IO;namespace IntentArc.Task2Review{public static class ParentReplacement{public static string Parent;public static string Moved;public static bool Attempted;public static bool Replaced;public static void Attempt(){Attempted=true;try{Directory.Move(Parent,Moved);Directory.CreateDirectory(Parent);Replaced=true;}catch(IOException){}catch(UnauthorizedAccessException){}}}}'",
        `New-Item -ItemType Directory -Path ${quote(parent)} -ErrorAction Stop|Out-Null`,
        `[IntentArc.Task2Review.ParentReplacement]::Parent=${quote(parent)};[IntentArc.Task2Review.ParentReplacement]::Moved=${quote(moved)}`,
        `$failed=$false;$root=$null;try{$root=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::CreateExclusiveRoot(${quote(parent)},'attempt')}catch{$failed=$true}`,
        "$rootProtected=$false;if($null-ne$root){$rootProtected=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::ValidateProtection($root);$root.Dispose()}",
        `$replacementGuard=[IntentArc.PreflightEnvelope.BoundaryGuard]::OpenDirectory(${quote(parent)},${quote(parent)});try{$replacementProtected=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::ValidateProtection($replacementGuard)}finally{$replacementGuard.Dispose()}`,
        `$moved=[IntentArc.PreflightEnvelope.EntryProbe]::Probe(${quote(moved)}).ToString()`,
        `$movedProtected=$false;if($moved-eq'Present'){$movedGuard=[IntentArc.PreflightEnvelope.BoundaryGuard]::OpenDirectory(${quote(moved)},${quote(moved)});try{$movedProtected=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::ValidateProtection($movedGuard)}finally{$movedGuard.Dispose()}}`,
        "[ordered]@{attempted=[IntentArc.Task2Review.ParentReplacement]::Attempted;replaced=[IntentArc.Task2Review.ParentReplacement]::Replaced;failed=$failed;moved=$moved;rootProtected=$rootProtected;replacementProtected=$replacementProtected;movedProtected=$movedProtected}|ConvertTo-Json -Compress",
      ].join("\n");
      expect(await runBoundaryHarness(body, reviewedPath)).toEqual({ attempted: true, replaced: false, failed: false, moved: "Absent", rootProtected: true, replacementProtected: true, movedProtected: false });
    } finally { await disposeFixture(fixture); }
  });

  it("fails closed when identity-bound temporary cleanup is sharing denied and proves exact absence after release", async () => {
    const fixture = await createFixture();
    try {
      const parent = join(fixture.root, "cleanup parent"); const temporary = join(parent, "attempt", ".stuck.tmp");
      const body = [
        `New-Item -ItemType Directory -Path ${quote(parent)} -ErrorAction Stop|Out-Null`,
        `$root=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::CreateExclusiveRoot(${quote(parent)},'attempt');$bytes=[Text.Encoding]::UTF8.GetBytes('temporary')`,
        "$file=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::WriteAtomicNew($root,'.stuck.tmp',$bytes);$identity=$file.StableIdentity;$file.Dispose()",
        "$flags=[Reflection.BindingFlags]::NonPublic -bor [Reflection.BindingFlags]::Static;$method=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore].GetMethod('CleanupTemporary',$flags)",
        "$wrongIdentity=$false;try{[void]$method.Invoke($null,@($root,'.stuck.tmp','00000000:0000000000000000'))}catch{$wrongIdentity=$true}",
        `$lease=[IO.File]::Open(${quote(temporary)},[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None);$denied=$false`,
        "try{try{[void]$method.Invoke($null,@($root,'.stuck.tmp',$identity))}catch{$denied=$true}}finally{$lease.Dispose()}",
        "[void]$method.Invoke($null,@($root,'.stuck.tmp',$identity));$after=[IntentArc.PreflightEnvelope.EntryProbe]::Probe(" + quote(temporary) + ").ToString();$root.Dispose()",
        "[ordered]@{methodFound=$null-ne$method;wrongIdentity=$wrongIdentity;denied=$denied;after=$after}|ConvertTo-Json -Compress",
      ].join("\n");
      expect(await runBoundaryHarness(body)).toEqual({ methodFound: true, wrongIdentity: true, denied: true, after: "Absent" });
    } finally { await disposeFixture(fixture); }
  });

  it("refuses cleanup success unless the bound temporary probes exactly absent", async () => {
    const fixture = await createFixture();
    try {
      const reviewedPath = join(fixture.root, "reviewed cleanup absence.ps1");
      const parent = join(fixture.root, "cleanup absence parent"); const temporary = join(parent, "attempt", ".present.tmp");
      const source = await readFile(scriptPath, "utf8");
      const needle = "    private static void DeleteBoundIdentity(BoundaryGuard guard) {";
      const instrumented = source.replace(needle, `${needle}\n      if (String.Equals(Environment.GetEnvironmentVariable(\"INTENTARC_TASK2_SKIP_DELETE\"), \"1\", StringComparison.Ordinal)) return;`);
      expect(instrumented).not.toBe(source); await writeFile(reviewedPath, instrumented, "utf8");
      const body = [
        `New-Item -ItemType Directory -Path ${quote(parent)} -ErrorAction Stop|Out-Null`,
        `$root=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::CreateExclusiveRoot(${quote(parent)},'attempt');$bytes=[Text.Encoding]::UTF8.GetBytes('temporary')`,
        "$file=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::WriteAtomicNew($root,'.present.tmp',$bytes);$identity=$file.StableIdentity;$file.Dispose()",
        "$flags=[Reflection.BindingFlags]::NonPublic -bor [Reflection.BindingFlags]::Static;$method=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore].GetMethod('CleanupTemporary',$flags);$env:INTENTARC_TASK2_SKIP_DELETE='1'",
        "$rejected=$false;try{[void]$method.Invoke($null,@($root,'.present.tmp',$identity))}catch{$rejected=$true}",
        `$after=[IntentArc.PreflightEnvelope.EntryProbe]::Probe(${quote(temporary)}).ToString();$root.Dispose()`,
        "[ordered]@{rejected=$rejected;after=$after}|ConvertTo-Json -Compress",
      ].join("\n");
      expect(await runBoundaryHarness(body, reviewedPath)).toEqual({ rejected: true, after: "Present" });
    } finally { await disposeFixture(fixture); }
  });

  it("identity-cleans a created temporary when protected writing fails before promotion", async () => {
    const fixture = await createFixture();
    try {
      const reviewedPath = join(fixture.root, "reviewed temporary fault.ps1");
      const parent = join(fixture.root, "temporary fault parent");
      const source = await readFile(scriptPath, "utf8");
      const needle = "        guard.WriteAndFlush(bytes);";
      const instrumented = source.replace(needle, `${needle}\n        if (String.Equals(Environment.GetEnvironmentVariable(\"INTENTARC_TASK2_TEMP_FAULT\"), \"1\", StringComparison.Ordinal)) throw new InvalidOperationException(\"fixture-write-fault\");`);
      expect(instrumented).not.toBe(source); await writeFile(reviewedPath, instrumented, "utf8");
      const body = [
        `New-Item -ItemType Directory -Path ${quote(parent)} -ErrorAction Stop|Out-Null`,
        "$env:INTENTARC_TASK2_TEMP_FAULT='1'",
        `$root=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::CreateExclusiveRoot(${quote(parent)},'attempt')`,
        "$rejected=$false;try{[void][IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::WriteAtomicNew($root,'authorization.json',[Text.Encoding]::UTF8.GetBytes('x'))}catch{$rejected=$true}",
        `$temporaryCount=@(Get-ChildItem -LiteralPath ${quote(join(parent, "attempt"))} -Force|Where-Object{$_.Name -like '*.tmp'}).Count`,
        "$root.Dispose();[ordered]@{rejected=$rejected;temporaryCount=$temporaryCount}|ConvertTo-Json -Compress",
      ].join("\n");
      expect(await runBoundaryHarness(body, reviewedPath)).toEqual({ rejected: true, temporaryCount: 0 });
    } finally { await disposeFixture(fixture); }
  });

  it("rejects injected owner, protected-DACL, and exact-ACE observation mismatches", async () => {
    const body = [
      "$flags=[Reflection.BindingFlags]::NonPublic -bor [Reflection.BindingFlags]::Static;$method=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore].GetMethod('IsClosedDescriptor',$flags)",
      "$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
      "$good=[Security.AccessControl.RawSecurityDescriptor]::new(('O:'+ $sid +'D:P(A;OICI;FA;;;'+$sid+')(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)'))",
      "$wrongOwner=[Security.AccessControl.RawSecurityDescriptor]::new(('O:BAD:P(A;OICI;FA;;;'+$sid+')(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)'))",
      "$unprotected=[Security.AccessControl.RawSecurityDescriptor]::new(('O:'+ $sid +'D:(A;OICI;FA;;;'+$sid+')(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)'))",
      "$wrongAce=[Security.AccessControl.RawSecurityDescriptor]::new(('O:'+ $sid +'D:P(A;OICI;FR;;;'+$sid+')(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)'))",
      "$goodValue=[bool]$method.Invoke($null,@($good,$true));$ownerValue=[bool]$method.Invoke($null,@($wrongOwner,$true));$protectedValue=[bool]$method.Invoke($null,@($unprotected,$true));$aceValue=[bool]$method.Invoke($null,@($wrongAce,$true))",
      "[ordered]@{methodFound=$null-ne$method;good=$goodValue;owner=$ownerValue;protected=$protectedValue;ace=$aceValue}|ConvertTo-Json -Compress",
    ].join("\n");
    expect(await runBoundaryHarness(body)).toEqual({ methodFound: true, good: true, owner: false, protected: false, ace: false });
  });
});

describe.sequential("desktop release preflight once permanent consumption state machine", () => {
  it("constructs an inert operation map with the exact ordered names and classifications", async () => {
    const names = [
      "BindExecutionInputs", "GetRepositoryState", "GuardBoundaries", "ProbeId06Unused", "CreateAttemptRoot",
      "CopyAuthorization", "WriteConsumptionAttempted", "StartController", "WriteControllerStarted", "FinalizeControllerAttempt",
    ];
    const body = [
      `. ${quote(scriptPath)}`,
      "$invocations=0;$handlers=[ordered]@{}",
      ...names.map((name) => `$handlers[${quote(name)}]={$invocations++;throw 'must-remain-inert'}`),
      "$operations=New-IntentArcPreflightEnvelopeOperations -Handlers $handlers",
      "$ordered=@(Get-IntentArcPreflightEnvelopeOperationNames)",
      "$actual=@($operations.PSObject.Properties|ForEach-Object{$_.Name})",
      "$categories=@($actual|ForEach-Object{$operations.$_.category})",
      "[ordered]@{ordered=$ordered;actual=$actual;categories=$categories;invocations=$invocations}|ConvertTo-Json -Compress -Depth 8",
    ].join("\n");
    expect(JSON.parse(await runPowerShell(body))).toEqual({
      ordered: names,
      actual: names,
      categories: ["observation", "observation", "observation", "observation", "evidence-mutation", "evidence-mutation", "evidence-mutation", "controller-launch", "evidence-mutation", "evidence-mutation"],
      invocations: 0,
    });
  });

  it("writes durable immutable consumption before one process call and then records the valid start", async () => {
    const fixture = await createFixture();
    try {
      const result = await runExecuteHarness(fixture);
      expect(result.errors).toEqual([]);
      expect(result.operations).toEqual([
        "BindExecutionInputs", "GetRepositoryState", "GuardBoundaries", "ProbeId06Unused",
        "CreateAttemptRoot", "CopyAuthorization", "WriteConsumptionAttempted", "StartController",
        "WriteControllerStarted", "FinalizeControllerAttempt",
      ]);
      expect(result.controllerStarts).toBe(1);
      expect(result.finalizations).toBe(1);
      expect(result.controllerStartedWrites).toBe(1);
      expect(result.outRenameSucceeded).toBe(true);
      const attemptRoot = join(fixture.root, ".superpowers", "preflight-execution-envelope", "phase1-preflight-envelope-20260902-01");
      const authorization = await readFile(join(attemptRoot, "authorization.json"));
      const consumedBytes = await readFile(join(attemptRoot, "consumed.json"));
      const startedBytes = await readFile(join(attemptRoot, "controller-started.json"));
      expect(authorization).toEqual(Buffer.from(JSON.stringify(fixture.document)));
      const consumed = JSON.parse(consumedBytes.toString()) as Record<string, unknown>;
      const started = JSON.parse(startedBytes.toString()) as Record<string, unknown>;
      expect(Object.keys(consumed)).toEqual(["schema", "attemptId", "authorizationSha256", "consumedAtUtc", "controllerLaunchStatus"]);
      expect(consumed).toMatchObject({
        schema: "intentarc.preflight-execution-consumed/v1", attemptId: "phase1-preflight-envelope-20260902-01",
        authorizationSha256: sha256(authorization), controllerLaunchStatus: "attempted",
      });
      expect(consumed.consumedAtUtc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
      expect(Object.keys(started)).toEqual(["schema", "attemptId", "controllerRunId", "authorizationSha256", "consumedSha256", "controllerProcessId", "controllerStartTimeUtc", "recordedAtUtc"]);
      expect(started).toMatchObject({
        schema: "intentarc.preflight-execution-controller-started/v1", attemptId: "phase1-preflight-envelope-20260902-01",
        controllerRunId: "phase1-preflight-20260901-06", authorizationSha256: sha256(authorization),
        consumedSha256: sha256(consumedBytes), controllerProcessId: 4242,
        controllerStartTimeUtc: "2026-09-02T00:00:01.000Z",
      });
      expect(started.recordedAtUtc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
      expect(String(started.recordedAtUtc) >= String(started.controllerStartTimeUtc)).toBe(true);
    } finally { await disposeFixture(fixture); }
  });

  it("pins consumed through launch and controller-started through finalization against same-account writers", async () => {
    const fixture = await createFixture();
    try {
      const result = await runExecuteHarness(fixture, { journalMutationProbe: true });
      expect(result.errors).toEqual([]);
      expect(result.consumedWriterOpened).toBe(false);
      expect(result.startedWriterOpened).toBe(false);
      expect(result.postExecuteConsumedWriterOpened).toBe(true);
      expect(result.postExecuteStartedWriterOpened).toBe(true);
      const attemptRoot = join(fixture.root, ".superpowers", "preflight-execution-envelope", "phase1-preflight-envelope-20260902-01");
      expect(JSON.parse((await readFile(join(attemptRoot, "consumed.json"))).toString())).toMatchObject({
        schema: "intentarc.preflight-execution-consumed/v1", controllerLaunchStatus: "attempted",
      });
      expect(JSON.parse((await readFile(join(attemptRoot, "controller-started.json"))).toString())).toMatchObject({
        schema: "intentarc.preflight-execution-controller-started/v1", controllerProcessId: 4242,
      });
    } finally { await disposeFixture(fixture); }
  });

  it.each([
    ["prelaunch result rejection", { resultOverride: { operation: "WriteConsumptionAttempted", expression: "[pscustomobject][ordered]@{sha256=7}" } }],
    ["finalizer exception", { throwAt: "FinalizeControllerAttempt" }],
  ] as const)("releases retained journals after %s", async (_name, options) => {
    const fixture = await createFixture();
    try {
      const result = await runExecuteHarness(fixture, { ...options, journalMutationProbe: true });
      expect(result.errors).toHaveLength(1);
      expect(result.consumedWriterOpened).toBe(false);
      expect(result.startedWriterOpened).toBe(false);
      expect(result.postExecuteConsumedWriterOpened).toBe(true);
      expect(result.postExecuteStartedWriterOpened).toBe(_name === "finalizer exception");
    } finally { await disposeFixture(fixture); }
  });

  const closedOperationContracts = [
    ["BindExecutionInputs", "[pscustomobject][ordered]@{valid=$true}", "valid", "$true"],
    ["GetRepositoryState", "[pscustomobject][ordered]@{valid=$true}", "valid", "$true"],
    ["GuardBoundaries", "[pscustomobject][ordered]@{valid=$true;outGuard=$state.outGuard}", "valid", "$true"],
    ["ProbeId06Unused", "[pscustomobject][ordered]@{unused=$true}", "unused", "$true"],
    ["CreateAttemptRoot", "[pscustomobject][ordered]@{created=$true}", "created", "$true"],
    ["CopyAuthorization", "[pscustomobject][ordered]@{sha256=$actual.sha256}", "sha256", "$actual.sha256"],
    ["WriteConsumptionAttempted", "[pscustomobject][ordered]@{sha256=$actual.sha256}", "sha256", "$actual.sha256"],
    ["StartController", "[pscustomobject][ordered]@{processCreated=$true;nonCreationProven=$false;supervisor=[pscustomobject][ordered]@{processId=4242;startTimeUtc='2026-09-02T00:00:01.000Z'};supervisorIdentityValid=$true;drainsInitialized=$true;setupCategory='none'}", "processCreated", "$true"],
    ["WriteControllerStarted", "[pscustomobject][ordered]@{sha256=$actual.sha256}", "sha256", "$actual.sha256"],
    ["FinalizeControllerAttempt", "[pscustomobject][ordered]@{finalized=$true}", "finalized", "$true"],
  ] as const;
  const operationContractMutations = closedOperationContracts.flatMap(([operation, valid, firstKey, firstValue]) => {
    const remaining = valid.slice(valid.indexOf(";") + 1, -1);
    const reordered = remaining === valid.slice(0, -1)
      ? `[pscustomobject][ordered]@{extra=$true;${firstKey}=${firstValue}}`
      : `[pscustomobject][ordered]@{${remaining};${firstKey}=${firstValue}}`;
    return [
      [`${operation} missing key`, operation, "[pscustomobject][ordered]@{}"],
      [`${operation} extra key`, operation, valid.replace(/}$/, ";extra=$true}")],
      [`${operation} reordered keys`, operation, reordered],
      [`${operation} wrong primitive type`, operation, `[pscustomobject][ordered]@{${firstKey}=7}`],
      [`${operation} null`, operation, "$null"],
    ] as const;
  });
  it.each(operationContractMutations)("rejects closed injected result %s", async (_name, operation, expression) => {
    const fixture = await createFixture();
    try {
      const result = await runExecuteHarness(fixture, { resultOverride: { operation, expression } });
      expect(result.errors).toHaveLength(1);
      expect(result.controllerStarts).toBeLessThanOrEqual(1);
      if (["StartController", "WriteControllerStarted", "FinalizeControllerAttempt"].includes(operation)) {
        expect(result.finalizations).toBe(1);
      } else {
        expect(result.finalizations).toBe(0);
      }
    } finally { await disposeFixture(fixture); }
  });

  it.each([
    ["extra field", "[pscustomobject][ordered]@{valid=$true;outGuard=$state.outGuard;extra=$true}"],
    ["reordered fields", "[pscustomobject][ordered]@{outGuard=$state.outGuard;valid=$true}"],
    ["wrong companion type", "[pscustomobject][ordered]@{valid='true';outGuard=$state.outGuard}"],
  ] as const)("disposes an acquired out guard exactly once when GuardBoundaries returns %s", async (_name, expression) => {
    const fixture = await createFixture();
    try {
      const result = await runExecuteHarness(fixture, {
        countedOutGuard: true,
        manualOutGuardCleanup: false,
        resultOverride: { operation: "GuardBoundaries", expression },
      });
      expect(result.errors).toHaveLength(1);
      expect(result.outGuardDisposeCount).toBe(1);
      expect(result.controllerStarts).toBe(0);
    } finally { await disposeFixture(fixture); }
  });

  const semanticOperationContractMutations = [
    ["BindExecutionInputs false boolean", "BindExecutionInputs", "[pscustomobject][ordered]@{valid=$false}"],
    ["GetRepositoryState false boolean", "GetRepositoryState", "[pscustomobject][ordered]@{valid=$false}"],
    ["GuardBoundaries false boolean", "GuardBoundaries", "[pscustomobject][ordered]@{valid=$false;outGuard=$state.outGuard}"],
    ["GuardBoundaries path instead of guard", "GuardBoundaries", "[pscustomobject][ordered]@{valid=$true;outGuard='C:\\not-a-guard'}"],
    ["ProbeId06Unused false boolean", "ProbeId06Unused", "[pscustomobject][ordered]@{unused=$false}"],
    ["CreateAttemptRoot false boolean", "CreateAttemptRoot", "[pscustomobject][ordered]@{created=$false}"],
    ["CopyAuthorization uppercase hash", "CopyAuthorization", "[pscustomobject][ordered]@{sha256=('A'*64 -join '')}"],
    ["CopyAuthorization mismatched hash", "CopyAuthorization", "[pscustomobject][ordered]@{sha256=('0'*64 -join '')}"],
    ["WriteConsumptionAttempted malformed hash", "WriteConsumptionAttempted", "[pscustomobject][ordered]@{sha256='not-a-hash'}"],
    ["WriteControllerStarted uppercase hash", "WriteControllerStarted", "[pscustomobject][ordered]@{sha256=('A'*64 -join '')}"],
    ["FinalizeControllerAttempt false boolean", "FinalizeControllerAttempt", "[pscustomobject][ordered]@{finalized=$false}"],
  ] as const;
  it.each(semanticOperationContractMutations)("rejects semantic injected result %s", async (_name, operation, expression) => {
    const fixture = await createFixture();
    try {
      const result = await runExecuteHarness(fixture, { resultOverride: { operation, expression } });
      expect(result.errors).toHaveLength(1);
      expect(result.controllerStarts).toBeLessThanOrEqual(1);
    } finally { await disposeFixture(fixture); }
  });

  const malformedLaunchRecords = [
    ["unknown setup category", "[pscustomobject][ordered]@{processCreated=$true;nonCreationProven=$false;supervisor=[pscustomobject][ordered]@{processId=4242;startTimeUtc='2026-09-02T00:00:01.000Z'};supervisorIdentityValid=$true;drainsInitialized=$true;setupCategory='unknown'}"],
    ["missing supervisor field", "[pscustomobject][ordered]@{processCreated=$true;nonCreationProven=$false;supervisor=[pscustomobject][ordered]@{processId=4242};supervisorIdentityValid=$true;drainsInitialized=$true;setupCategory='none'}"],
    ["extra supervisor field", "[pscustomobject][ordered]@{processCreated=$true;nonCreationProven=$false;supervisor=[pscustomobject][ordered]@{processId=4242;startTimeUtc='2026-09-02T00:00:01.000Z';extra=$true};supervisorIdentityValid=$true;drainsInitialized=$true;setupCategory='none'}"],
    ["reordered supervisor fields", "[pscustomobject][ordered]@{processCreated=$true;nonCreationProven=$false;supervisor=[pscustomobject][ordered]@{startTimeUtc='2026-09-02T00:00:01.000Z';processId=4242};supervisorIdentityValid=$true;drainsInitialized=$true;setupCategory='none'}"],
    ["invalid supervisor timestamp", "[pscustomobject][ordered]@{processCreated=$true;nonCreationProven=$false;supervisor=[pscustomobject][ordered]@{processId=4242;startTimeUtc='2026-09-02T00:00:01Z'};supervisorIdentityValid=$true;drainsInitialized=$true;setupCategory='none'}"],
    ["zero supervisor PID", "[pscustomobject][ordered]@{processCreated=$true;nonCreationProven=$false;supervisor=[pscustomobject][ordered]@{processId=0;startTimeUtc='2026-09-02T00:00:01.000Z'};supervisorIdentityValid=$true;drainsInitialized=$true;setupCategory='none'}"],
    ["negative supervisor PID", "[pscustomobject][ordered]@{processCreated=$true;nonCreationProven=$false;supervisor=[pscustomobject][ordered]@{processId=-1;startTimeUtc='2026-09-02T00:00:01.000Z'};supervisorIdentityValid=$true;drainsInitialized=$true;setupCategory='none'}"],
    ["fractional supervisor PID", "[pscustomobject][ordered]@{processCreated=$true;nonCreationProven=$false;supervisor=[pscustomobject][ordered]@{processId=1.5;startTimeUtc='2026-09-02T00:00:01.000Z'};supervisorIdentityValid=$true;drainsInitialized=$true;setupCategory='none'}"],
    ["string processCreated", "[pscustomobject][ordered]@{processCreated='true';nonCreationProven=$false;supervisor=[pscustomobject][ordered]@{processId=4242;startTimeUtc='2026-09-02T00:00:01.000Z'};supervisorIdentityValid=$true;drainsInitialized=$true;setupCategory='none'}"],
    ["null nonCreationProven", "[pscustomobject][ordered]@{processCreated=$true;nonCreationProven=$null;supervisor=[pscustomobject][ordered]@{processId=4242;startTimeUtc='2026-09-02T00:00:01.000Z'};supervisorIdentityValid=$true;drainsInitialized=$true;setupCategory='none'}"],
    ["numeric supervisorIdentityValid", "[pscustomobject][ordered]@{processCreated=$true;nonCreationProven=$false;supervisor=[pscustomobject][ordered]@{processId=4242;startTimeUtc='2026-09-02T00:00:01.000Z'};supervisorIdentityValid=1;drainsInitialized=$true;setupCategory='none'}"],
    ["null drainsInitialized", "[pscustomobject][ordered]@{processCreated=$true;nonCreationProven=$false;supervisor=[pscustomobject][ordered]@{processId=4242;startTimeUtc='2026-09-02T00:00:01.000Z'};supervisorIdentityValid=$true;drainsInitialized=$null;setupCategory='none'}"],
    ["null setupCategory", "[pscustomobject][ordered]@{processCreated=$true;nonCreationProven=$false;supervisor=[pscustomobject][ordered]@{processId=4242;startTimeUtc='2026-09-02T00:00:01.000Z'};supervisorIdentityValid=$true;drainsInitialized=$true;setupCategory=$null}"],
  ] as const;
  it.each(malformedLaunchRecords)("rejects launch contract with %s", async (_name, expression) => {
    const fixture = await createFixture();
    try {
      const result = await runExecuteHarness(fixture, { resultOverride: { operation: "StartController", expression } });
      expect(result.errors).toHaveLength(1);
      expect(result.controllerStarts).toBe(1);
      expect(result.controllerStartedWrites).toBe(0);
      expect(result.finalizations).toBe(1);
    } finally { await disposeFixture(fixture); }
  });

  const launchRows = [
    ["non-creation", { processCreated: false, nonCreationProven: true, supervisor: null, supervisorIdentityValid: false, drainsInitialized: false, setupCategory: "launch-failed" }, 0],
    ["invalid supervisor identity", { processCreated: true, nonCreationProven: false, supervisor: { processId: 4242, startTimeUtc: "2026-09-02T00:00:01.000Z" }, supervisorIdentityValid: false, drainsInitialized: true, setupCategory: "supervisor-identity-invalid" }, 0],
    ["invalid supervisor identity wins over drain failure", { processCreated: true, nonCreationProven: false, supervisor: { processId: 4242, startTimeUtc: "2026-09-02T00:00:01.000Z" }, supervisorIdentityValid: false, drainsInitialized: false, setupCategory: "supervisor-identity-invalid" }, 0],
    ["drain initialization failure", { processCreated: true, nonCreationProven: false, supervisor: { processId: 4242, startTimeUtc: "2026-09-02T00:00:01.000Z" }, supervisorIdentityValid: true, drainsInitialized: false, setupCategory: "drain-initialization-invalid" }, 1],
    ["fully initialized", { processCreated: true, nonCreationProven: false, supervisor: { processId: 4242, startTimeUtc: "2026-09-02T00:00:01.000Z" }, supervisorIdentityValid: true, drainsInitialized: true, setupCategory: "none" }, 1],
  ] as const;
  it.each(launchRows)("enforces the exact six-key launch matrix for %s", async (_name, start, expectedStartedWrites) => {
    const fixture = await createFixture();
    try {
      const result = await runExecuteHarness(fixture, { start });
      expect(result.errors).toEqual([]);
      expect(result.controllerStarts).toBe(1);
      expect(result.finalizations).toBe(1);
      expect(result.controllerStartedWrites).toBe(expectedStartedWrites);
    } finally { await disposeFixture(fixture); }
  });

  const contradictoryLaunchRows = [
    ["false creation without non-creation proof", { processCreated: false, nonCreationProven: false, supervisor: null, supervisorIdentityValid: false, drainsInitialized: false, setupCategory: "launch-failed" }],
    ["false creation with supervisor", { processCreated: false, nonCreationProven: true, supervisor: { processId: 4242, startTimeUtc: "2026-09-02T00:00:01.000Z" }, supervisorIdentityValid: false, drainsInitialized: false, setupCategory: "launch-failed" }],
    ["created process claiming non-creation", { processCreated: true, nonCreationProven: true, supervisor: { processId: 4242, startTimeUtc: "2026-09-02T00:00:01.000Z" }, supervisorIdentityValid: true, drainsInitialized: true, setupCategory: "none" }],
    ["identity fault mislabeled as drain fault", { processCreated: true, nonCreationProven: false, supervisor: { processId: 4242, startTimeUtc: "2026-09-02T00:00:01.000Z" }, supervisorIdentityValid: false, drainsInitialized: false, setupCategory: "drain-initialization-invalid" }],
    ["valid identity and drains mislabeled", { processCreated: true, nonCreationProven: false, supervisor: { processId: 4242, startTimeUtc: "2026-09-02T00:00:01.000Z" }, supervisorIdentityValid: true, drainsInitialized: true, setupCategory: "supervisor-identity-invalid" }],
  ] as const;
  it.each(contradictoryLaunchRows)("rejects contradictory launch record %s but finalizes once", async (_name, start) => {
    const fixture = await createFixture();
    try {
      const result = await runExecuteHarness(fixture, { start });
      expect(result.errors).toHaveLength(1);
      expect(result.controllerStarts).toBe(1);
      expect(result.controllerStartedWrites).toBe(0);
      expect(result.finalizations).toBe(1);
    } finally { await disposeFixture(fixture); }
  });

  it.each([
    "BindExecutionInputs", "GetRepositoryState", "GuardBoundaries", "ProbeId06Unused", "CreateAttemptRoot",
    "CopyAuthorization", "WriteConsumptionAttempted", "StartController", "WriteControllerStarted", "FinalizeControllerAttempt",
  ])("closes the host loss seam after %s and never starts a second process", async (faultAfter) => {
    const fixture = await createFixture();
    try {
      const result = await runExecuteHarness(fixture, { faultAfter, replay: true });
      expect(result.errors.length).toBeGreaterThanOrEqual(1);
      expect(result.controllerStarts).toBeLessThanOrEqual(1);
      if (["BindExecutionInputs", "GetRepositoryState", "GuardBoundaries", "ProbeId06Unused"].includes(faultAfter)) expect(result.controllerStarts).toBe(1);
      else expect(result.rootExists).toBe("Present");
    } finally { await disposeFixture(fixture); }
  });

  it.each(["CopyAuthorization", "WriteConsumptionAttempted"])("blocks launch and replay on %s write, flush, reopen, or protection failure", async (throwAt) => {
    const fixture = await createFixture();
    try {
      const result = await runExecuteHarness(fixture, { throwAt, replay: true });
      expect(result.controllerStarts).toBe(0);
      expect(result.rootExists).toBe("Present");
      expect(result.errors).toHaveLength(2);
    } finally { await disposeFixture(fixture); }
  });

  const journalFaultCases = (["consumed", "controller-started"] as const).flatMap((journal) =>
    (["write", "protection", "temporary-flush", "post-promotion-flush", "reopen"] as const).map((stage) => [journal, stage] as const),
  );
  it.each(journalFaultCases)("fails closed for a real %s %s stage fault and blocks replay", async (journal, stage) => {
    const fixture = await createFixture();
    try {
      const faultedScript = await writeTask3JournalFaultScript(fixture, journal, stage);
      const result = await runExecuteHarness(fixture, { scriptPath: faultedScript, journalMutationProbe: true, replay: true });
      const attemptRoot = join(fixture.root, ".superpowers", "preflight-execution-envelope", "phase1-preflight-envelope-20260902-01");
      const destination = join(attemptRoot, `${journal}.json`);
      const postPromotion = stage === "post-promotion-flush" || stage === "reopen";
      expect(result.rootExists).toBe("Present");
      expect(result.errors).toHaveLength(2);
      expect(result.controllerStarts).toBe(journal === "consumed" ? 0 : 1);
      expect(result.finalizations).toBe(journal === "consumed" ? 0 : 1);
      expect(result.consumedWriterOpened).toBe(false);
      expect(result.startedWriterOpened).toBe(false);
      expect(result.postExecuteConsumedWriterOpened).toBe(journal === "controller-started" || postPromotion);
      expect(result.postExecuteStartedWriterOpened).toBe(journal === "controller-started" && postPromotion);
      if (postPromotion) {
        const admitted = JSON.parse((await readFile(destination)).toString()) as Record<string, unknown>;
        expect(admitted.schema).toBe(journal === "consumed"
          ? "intentarc.preflight-execution-consumed/v1"
          : "intentarc.preflight-execution-controller-started/v1");
      } else {
        await expect(readFile(destination)).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally { await disposeFixture(fixture); }
  });

  it.each(["consumption", "controller-started"] as const)("treats immutable %s collision as terminal and blocks replay", async (collisionAt) => {
    const fixture = await createFixture();
    try {
      const result = await runExecuteHarness(fixture, { collisionAt, replay: true });
      expect(result.rootExists).toBe("Present");
      expect(result.controllerStarts).toBe(collisionAt === "consumption" ? 0 : 1);
      expect(result.finalizations).toBe(collisionAt === "consumption" ? 0 : 1);
      expect(result.errors).toHaveLength(2);
    } finally { await disposeFixture(fixture); }
  });

  it("finalizes exactly once when controller start is cancelled and never retries", async () => {
    const fixture = await createFixture();
    try {
      const result = await runExecuteHarness(fixture, { throwAt: "StartController", replay: true });
      expect(result.controllerStarts).toBe(1);
      expect(result.finalizations).toBe(1);
      expect(result.controllerStartedWrites).toBe(0);
      expect(result.rootExists).toBe("Present");
      expect(result.errors).toHaveLength(2);
    } finally { await disposeFixture(fixture); }
  });

  it("uses AST call-site proof for one launch/finalizer and rejects equivalent hidden lifecycle mutations", async () => {
    const source = await readFile(scriptPath, "utf8");
    expect(await task3AstViolations(scriptPath)).toEqual([]);
    const mutants = [
      source.replace("$Operations.StartController.Invoke(", "$Operations.StartController.Invoke($AuthorizationContext.Document);$Operations.StartController.Invoke("),
      source.replace("$launch = $Operations.StartController.Invoke($AuthorizationContext.Document)", "$null = $Operations['StartController'].Invoke($AuthorizationContext.Document)\n            $launch = $Operations.StartController.Invoke($AuthorizationContext.Document)"),
      source.replace("$Operations.FinalizeControllerAttempt.Invoke(", "$Operations.FinalizeControllerAttempt.Invoke($AuthorizationContext.Document,$launch,$controllerStartedValid);$Operations.FinalizeControllerAttempt.Invoke("),
      source.replace("$finalization = $Operations.FinalizeControllerAttempt.Invoke($AuthorizationContext.Document, $launch, $controllerStartedValid)", "$null = $Operations['FinalizeControllerAttempt'].Invoke($AuthorizationContext.Document,$launch,$controllerStartedValid)\n            $finalization = $Operations.FinalizeControllerAttempt.Invoke($AuthorizationContext.Document, $launch, $controllerStartedValid)"),
      source.replace("$launch = $Operations.StartController.Invoke($AuthorizationContext.Document)", "while ($true) { $launch = $Operations.StartController.Invoke($AuthorizationContext.Document) }"),
      source.replace("function Invoke-IntentArcPreflightEnvelopeExecute {", "function Invoke-IntentArcPreflightEnvelopeExecute {\n    [Diagnostics.Process]::Start('forbidden')"),
      source.replace("function Invoke-IntentArcPreflightEnvelopeExecute {", "function Invoke-IntentArcPreflightEnvelopeExecute {\n    $processInfo = New-Object System.Diagnostics.ProcessStartInfo"),
      source.replace("function Invoke-IntentArcPreflightEnvelopeExecute {", "function Invoke-IntentArcPreflightEnvelopeExecute {\n    $journalPath = Join-Path $env:TEMP 'later-name'; Remove-Item -LiteralPath $journalPath\n    $later = 'consumed.json'"),
      source.replace("function Invoke-IntentArcPreflightEnvelopeExecute {", "function Invoke-IntentArcPreflightEnvelopeExecute {\n    $journalPath = Join-Path $env:TEMP 'later-name'; [IO.File]::WriteAllText($journalPath,'x')\n    $later = 'controller-started.json'"),
      source.replace("function Invoke-IntentArcPreflightEnvelopeExecute {", "function Invoke-IntentArcPreflightEnvelopeExecute {\n    $journalStream.SetLength(0)\n    $later = 'consumed.json'"),
      source.replace("function Invoke-IntentArcPreflightEnvelopeExecute {", "function Invoke-IntentArcPreflightEnvelopeExecute {\n    $journalPath = Join-Path $env:TEMP 'later-name'; [IO.File]::Delete($journalPath)\n    $later = 'controller-started.json'"),
      source.replace("function Invoke-IntentArcPreflightEnvelopeExecute {", "function Invoke-IntentArcPreflightEnvelopeExecute {\n    $sourcePath = Join-Path $env:TEMP 'a'; $destinationPath = Join-Path $env:TEMP 'b'; [IO.File]::Replace($sourcePath,$destinationPath,$null)\n    $later = 'consumed.json'"),
      source.replace("function Invoke-IntentArcPreflightEnvelopeExecute {", "function Invoke-IntentArcPreflightEnvelopeExecute {\n    $journalPath = Join-Path $env:TEMP 'later-name'; Clear-Content -LiteralPath $journalPath\n    $later = 'controller-started.json'"),
      source.replace("function Invoke-IntentArcPreflightEnvelopeExecute {", "function Invoke-IntentArcPreflightEnvelopeExecute {\n    $journalStream.Write([byte[]](1),0,1)\n    $later = 'consumed.json'"),
      source.replace("function Invoke-IntentArcPreflightEnvelopeExecute {", "function Invoke-IntentArcPreflightEnvelopeExecute {\n    $sourcePath = Join-Path $env:TEMP 'a'; $destinationPath = Join-Path $env:TEMP 'b'; [IO.File]::Move($sourcePath,$destinationPath)\n    $later = 'controller-started.json'"),
      source.replace("controllerLaunchStatus = 'attempted'", "controllerLaunchStatus = 'not-attempted'"),
      source.replace("Assert-IntentArcPreflightEnvelopeBooleanRecord -Record $binding -Name 'valid'", "$null = $binding"),
      source.replace("Assert-IntentArcPreflightEnvelopeShaRecord -Record $consumption", "$null = $consumption"),
      source.replace("Assert-IntentArcPreflightEnvelopeLaunchRecord -Record $launch", "$null = $launch"),
      source.replace("function Write-IntentArcPreflightEnvelopeConsumptionAttempted {", "function Write-IntentArcPreflightEnvelopeConsumptionAttempted {\n    $journalPath = Join-Path $env:TEMP 'variable-first'; Remove-Item -LiteralPath $journalPath\n    $later = 'consumed.json'"),
      source.replace("function Write-IntentArcPreflightEnvelopeControllerStarted {", "function Write-IntentArcPreflightEnvelopeControllerStarted {\n    $journalPath = Join-Path $env:TEMP 'variable-first'; [IO.File]::WriteAllText($journalPath,'rewrite')\n    $later = 'controller-started.json'"),
      source.replace("function Write-IntentArcPreflightEnvelopeConsumptionAttempted {", "function Write-IntentArcPreflightEnvelopeConsumptionAttempted {\n    $journalStream.SetLength(0)\n    $later = 'consumed.json'"),
      source.replace("function Write-IntentArcPreflightEnvelopeControllerStarted {", "function Write-IntentArcPreflightEnvelopeControllerStarted {\n    $member = 'Write'; $journalStream.$member([byte[]](1),0,1)\n    $later = 'controller-started.json'"),
      source.replace("$launch = $Operations.StartController.Invoke($AuthorizationContext.Document)", "$name='StartController';$null=$Operations[$name].Invoke($AuthorizationContext.Document)\n            $launch = $Operations.StartController.Invoke($AuthorizationContext.Document)"),
      source.replace("$launch = $Operations.StartController.Invoke($AuthorizationContext.Document)", "$name='StartController';$null=$Operations.$name.Invoke($AuthorizationContext.Document)\n            $launch = $Operations.StartController.Invoke($AuthorizationContext.Document)"),
      source.replace("$launch = $Operations.StartController.Invoke($AuthorizationContext.Document)", "$null=& ($Operations.StartController) $AuthorizationContext.Document\n            $launch = $Operations.StartController.Invoke($AuthorizationContext.Document)"),
      source.replace("function Invoke-IntentArcPreflightEnvelopeExecute {", "function Invoke-IntentArcPreflightEnvelopeExecute {\n    $exe = 'forbidden.exe'; & $exe '--forbidden'"),
      source.replace("function Invoke-IntentArcPreflightEnvelopeExecute {", "function Invoke-IntentArcPreflightEnvelopeExecute {\n    $process = [Diagnostics.Process]::new(); $process.Start()"),
      source.replace("function Write-IntentArcPreflightEnvelopeConsumptionAttempted {", "function Write-IntentArcPreflightEnvelopeConsumptionAttempted {\n    $member='Delete';$methods=@{};$null=$methods[$member].Invoke($journalPath)\n    $later='consumed.json'"),
      source.replace("$launch = $Operations.StartController.Invoke($AuthorizationContext.Document)", "$null = $Operations.StartController.InvokeReturnAsIs($AuthorizationContext.Document)\n            $launch = $Operations.StartController.Invoke($AuthorizationContext.Document)"),
      source.replace("function Invoke-IntentArcPreflightEnvelopeExecute {", "function Invoke-IntentArcPreflightEnvelopeExecute {\n    powershell.exe -NoProfile -Command 'exit 0'"),
      source.replace("function Assert-IntentArcPreflightEnvelopeOperations {", "function Assert-IntentArcPreflightEnvelopeOperations {\n    $null = $Operations.StartController.Invoke($null)"),
      source.replace("function Invoke-IntentArcPreflightEnvelopeExecute {", "function Invoke-IntentArcPreflightEnvelopeReachableMutant { Remove-Item -LiteralPath $env:TEMP }\n\nfunction Invoke-IntentArcPreflightEnvelopeExecute {\n    Invoke-IntentArcPreflightEnvelopeReachableMutant"),
      source.replace("function Invoke-IntentArcPreflightEnvelopeExecute {", "function Invoke-IntentArcPreflightEnvelopeExecute {\n    Set-Alias task3-launch-alias powershell.exe; task3-launch-alias -NoProfile"),
      source.replace("function Assert-IntentArcPreflightEnvelopeOperations {", "function Assert-IntentArcPreflightEnvelopeOperations {\n    $captured = $Operations.StartController"),
      source.replace("if (-not $script:IntentArcPreflightEnvelopeWasDotSourced) {", "if (-not $script:IntentArcPreflightEnvelopeWasDotSourced) {\n    [Diagnostics.Process]::Start('forbidden')"),
      source.replace("if (-not $script:IntentArcPreflightEnvelopeWasDotSourced) {", "if (-not $script:IntentArcPreflightEnvelopeWasDotSourced) {\n    $process = [Diagnostics.Process]::new(); $process.Start()"),
      source.replace("if (-not $script:IntentArcPreflightEnvelopeWasDotSourced) {", "if (-not $script:IntentArcPreflightEnvelopeWasDotSourced) {\n    powershell.exe -NoProfile -Command 'exit 0'"),
      source.replace("if (-not $script:IntentArcPreflightEnvelopeWasDotSourced) {", "if (-not $script:IntentArcPreflightEnvelopeWasDotSourced) {\n    Set-Alias task3-top-alias powershell.exe; task3-top-alias -NoProfile"),
      source.replace("if (-not $script:IntentArcPreflightEnvelopeWasDotSourced) {", "if (-not $script:IntentArcPreflightEnvelopeWasDotSourced) {\n    $exe = 'powershell.exe'; & $exe -NoProfile"),
      source.replace("if (-not $script:IntentArcPreflightEnvelopeWasDotSourced) {", "if (-not $script:IntentArcPreflightEnvelopeWasDotSourced) {\n    Remove-Item -LiteralPath $env:TEMP"),
      source.replace("function Assert-IntentArcPreflightEnvelopeOperations {", "function Assert-IntentArcPreflightEnvelopeOperations {\n    $captured = $operations.StartController"),
      source.replace("function Get-IntentArcPreflightExecutionProductionInvocationMetadata {\n    param()", "function Get-IntentArcPreflightExecutionProductionInvocationMetadata {\n    param()\n    [Diagnostics.Process]::Start('forbidden')"),
      source.replace("    param([Parameter(Mandatory)][string[]] $RawArguments, [Parameter(Mandatory)] $InvocationMetadata)", "    param([Parameter(Mandatory)][string[]] $RawArguments, [Parameter(Mandatory)] $InvocationMetadata)\n    powershell.exe -NoProfile -Command 'exit 0'"),
      source.replace("function New-IntentArcPreflightExecutionAuthorizationRefusal {", "function New-IntentArcPreflightExecutionAuthorizationRefusal {\n    Remove-Item -LiteralPath $env:TEMP"),
      source.replace("if (-not $script:IntentArcPreflightEnvelopeWasDotSourced) {", "if (-not $script:IntentArcPreflightEnvelopeWasDotSourced) {\n    'forbidden' > $env:TEMP"),
      source.replace("    Assert-IntentArcPreflightEnvelopeOperations -Operations $Operations", "    Assert-IntentArcPreflightEnvelopeOperations -Operations $Operations\n    'forbidden' >> $env:TEMP"),
      source.replace("$script:IntentArcPreflightEnvelopeProductionArguments = [string[]] @($args)", "$script:IntentArcPreflightEnvelopeProductionArguments = [string[]] @(${Alias:New-IntentArcPreflightEnvelopeProductionContract} = 'powershell.exe'; $args)"),
      source.replace("    Assert-IntentArcPreflightEnvelopeOperations -Operations $Operations", "    Assert-IntentArcPreflightEnvelopeOperations -Operations $Operations\n    ${Alias:Assert-IntentArcPreflightEnvelopeAuthorizationContext} = 'powershell.exe'"),
      source.replace("$script:IntentArcPreflightEnvelopeProductionArguments = [string[]] @($args)", "$script:IntentArcPreflightEnvelopeProductionArguments = [string[]] @(${Function:New-IntentArcPreflightEnvelopeProductionContract} = { 'forbidden' }; $args)"),
      source.replace("    Assert-IntentArcPreflightEnvelopeOperations -Operations $Operations", "    Assert-IntentArcPreflightEnvelopeOperations -Operations $Operations\n    ${Function:Assert-IntentArcPreflightEnvelopeAuthorizationContext} = { 'forbidden' }"),
      source.replace("function Get-IntentArcPreflightExecutionProductionInvocationMetadata {\n    param()", "function Get-IntentArcPreflightExecutionProductionInvocationMetadata {\n    param()\n    Set-Item -LiteralPath Alias:New-IntentArcPreflightEnvelopeProductionContract -Value powershell.exe"),
      source.replace("    param([Parameter(Mandatory)][string[]] $RawArguments, [Parameter(Mandatory)] $InvocationMetadata)", "    param([Parameter(Mandatory)][string[]] $RawArguments, [Parameter(Mandatory)] $InvocationMetadata)\n    New-Item -Path Function:Assert-IntentArcPreflightEnvelopeAuthorizationContext -Value { 'forbidden' }"),
      source.replace("    param([Parameter(Mandatory)] $Invocation, [Parameter(Mandatory)] $Contract)\n    try {", "    param([Parameter(Mandatory)] $Invocation, [Parameter(Mandatory)] $Contract)\n    Remove-Item -LiteralPath Alias:New-IntentArcPreflightEnvelopeProductionContract\n    try {"),
      source.replace("function Read-IntentArcPreflightExecutionAuthorizationManifest {", "function Read-IntentArcPreflightExecutionAuthorizationManifest {\n    Set-Content -LiteralPath Alias:New-IntentArcPreflightEnvelopeProductionContract -Value powershell.exe"),
      source.replace("function Read-IntentArcPreflightExecutionAuthorizationManifest {", "function Read-IntentArcPreflightExecutionAuthorizationManifest {\n    Set-Content -LiteralPath Function:Assert-IntentArcPreflightEnvelopeAuthorizationContext -Value { 'forbidden' }"),
      source.replace("function Read-IntentArcPreflightExecutionAuthorizationManifest {", "function Read-IntentArcPreflightExecutionAuthorizationManifest {\n    Add-Content -LiteralPath Alias:New-IntentArcPreflightEnvelopeProductionContract -Value powershell.exe"),
      source.replace("function Read-IntentArcPreflightExecutionAuthorizationManifest {", "function Read-IntentArcPreflightExecutionAuthorizationManifest {\n    Add-Content -LiteralPath Function:Assert-IntentArcPreflightEnvelopeAuthorizationContext -Value { 'forbidden' }"),
      source.replace("function Assert-IntentArcPreflightEnvelopeAuthorizationContext {", "function Assert-IntentArcPreflightEnvelopeAuthorizationContext {}\n\nfunction Assert-IntentArcPreflightEnvelopeAuthorizationContext {"),
      source.replace("function Invoke-IntentArcPreflightEnvelopeExecute {", "function Invoke-IntentArcPreflightEnvelopeExecute {\n    function Assert-IntentArcPreflightEnvelopeAuthorizationContext {}"),
    ];
    const fixture = await createFixture();
    try {
      const survivors: number[] = [];
      for (const [index, mutant] of mutants.entries()) {
        expect(mutant, `mutant ${index + 1} must alter source`).not.toBe(source);
        const mutantPath = join(fixture.root, `task3-ast-mutant-${index + 1}.ps1`);
        await writeFile(mutantPath, mutant, "utf8");
        const violations = await task3AstViolations(mutantPath);
        expect(violations, `mutant ${index + 1} must parse`).not.toContain("parse error");
        if (violations.length === 0) survivors.push(index + 1);
      }
      expect(survivors, "all valid in-memory mutants must be rejected").toEqual([]);
    } finally { await disposeFixture(fixture); }
  }, 120_000);
});

describe.sequential("desktop release preflight once Task 4 process capture", () => {
  it("builds the exact fixed controller vector and six-entry closed environment", async () => {
    const fixture = await createFixture();
    try {
      fixture.document.outerPowerShellPath = powerShell;
      fixture.document.pnpmPath = join(fixture.root, "pnpm executable.exe");
      await writeFile(fixture.document.pnpmPath, "pnpm fixture", "utf8");
      const result = await runBoundaryHarness([
        `$document=${quote(JSON.stringify(fixture.document))}|ConvertFrom-Json`,
        "$info=New-IntentArcPreflightControllerStartInfo -AuthorizationDocument $document",
        "$tokens=@(ConvertFrom-IntentArcPreflightExecutionWindowsCommandLine -CommandLine ('fixture.exe '+$info.Arguments))|Select-Object -Skip 1",
        "$environment=[ordered]@{};foreach($name in @($info.EnvironmentVariables.Keys|Sort-Object)){$environment[$name]=[string]$info.EnvironmentVariables[$name]}",
        "[ordered]@{fileName=$info.FileName;arguments=@($tokens);workingDirectory=$info.WorkingDirectory;useShellExecute=$info.UseShellExecute;redirectStdout=$info.RedirectStandardOutput;redirectStderr=$info.RedirectStandardError;createNoWindow=$info.CreateNoWindow;windowStyle=[string]$info.WindowStyle;environment=$environment}|ConvertTo-Json -Compress -Depth 8",
      ].join("\n"));
      expect(result).toEqual({
        fileName: powerShell,
        arguments: ["-NoProfile", "-NonInteractive", "-File", fixture.paths.controller, "-Execute", "-ExpectedCommit", fixture.document.expectedCommit, "-PnpmExecutable", fixture.document.pnpmPath, "-ExpectedPnpmSha256", fixture.document.pnpmSha256],
        workingDirectory: fixture.root,
        useShellExecute: false,
        redirectStdout: true,
        redirectStderr: true,
        createNoWindow: true,
        windowStyle: "Hidden",
        environment: {
          ComSpec: "C:\\Windows\\System32\\cmd.exe",
          NoDefaultCurrentDirectoryInExePath: "1",
          SystemRoot: "C:\\Windows",
          TEMP: "C:\\Users\\synthetic-user\\AppData\\Local\\Temp",
          TMP: "C:\\Users\\synthetic-user\\AppData\\Local\\Temp",
          WINDIR: "C:\\Windows",
        },
      });
    } finally { await disposeFixture(fixture); }
  });

  it.each([
    ["root", ["rev-parse", "--show-toplevel"]],
    ["branch", ["symbolic-ref", "--quiet", "--short", "HEAD"]],
    ["head", ["rev-parse", "--verify", "HEAD"]],
    ["status", ["status", "--porcelain=v1", "--untracked-files=no"]],
  ] as const)("builds exact bounded Git observation %s", async (observation, suffix) => {
    const fixture = await createFixture();
    try {
      fixture.document.gitPath = "C:\\Program Files\\Git\\cmd\\git.exe";
      const result = await runBoundaryHarness([
        `$document=${quote(JSON.stringify(fixture.document))}|ConvertFrom-Json`,
        `$info=New-IntentArcPreflightGitObservationStartInfo -AuthorizationDocument $document -Observation ${quote(observation)}`,
        "$tokens=@(ConvertFrom-IntentArcPreflightExecutionWindowsCommandLine -CommandLine ('fixture.exe '+$info.Arguments))|Select-Object -Skip 1",
        "$environment=[ordered]@{};foreach($name in @($info.EnvironmentVariables.Keys|Sort-Object)){$environment[$name]=[string]$info.EnvironmentVariables[$name]}",
        "[ordered]@{role=[string][IntentArc.PreflightEnvelope.ProcessRole]::GitObservation;fileName=$info.FileName;arguments=@($tokens);workingDirectory=$info.WorkingDirectory;environment=$environment}|ConvertTo-Json -Compress -Depth 8",
      ].join("\n"));
      expect(result).toEqual({
        role: "GitObservation",
        fileName: fixture.document.gitPath,
        arguments: ["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", fixture.root, ...suffix],
        workingDirectory: fixture.root,
        environment: {
          ComSpec: "C:\\Windows\\System32\\cmd.exe", GIT_CONFIG_GLOBAL: "NUL", GIT_CONFIG_NOSYSTEM: "1",
          NoDefaultCurrentDirectoryInExePath: "1", SystemRoot: "C:\\Windows",
          TEMP: "C:\\Users\\synthetic-user\\AppData\\Local\\Temp", TMP: "C:\\Users\\synthetic-user\\AppData\\Local\\Temp", WINDIR: "C:\\Windows",
        },
      });
    } finally { await disposeFixture(fixture); }
  });

  it("performs bounded capture byte-exactly while hashing stderr without returning its text", async () => {
    const fixture = await createFixture();
    try {
      const stdout = Buffer.from(" \n{\"status\":\"fixture\",\"value\":\"€\"}\r\n ", "utf8");
      const stderr = Buffer.from("sensitive-stderr-€", "utf8");
      const childDirectory = join(fixture.root, "scripts");
      await mkdir(childDirectory);
      const childPath = join(childDirectory, "desktop-release-preflight-out-preservation.ps1");
      await writeFile(childPath, [
        "param([switch]$Execute,[string]$ExpectedCommit,[string]$PnpmExecutable,[string]$ExpectedPnpmSha256)",
        `$stdout=[Convert]::FromBase64String(${quote(stdout.toString("base64"))})`,
        `$stderr=[Convert]::FromBase64String(${quote(stderr.toString("base64"))})`,
        "$out=[Console]::OpenStandardOutput();$err=[Console]::OpenStandardError()",
        "$maximum=[Math]::Max($stdout.Length,$stderr.Length);for($index=0;$index-lt$maximum;$index++){if($index-lt$stdout.Length){$out.Write($stdout,$index,1);$out.Flush()};if($index-lt$stderr.Length){$err.Write($stderr,$index,1);$err.Flush()}}",
      ].join("\n"), "utf8");
      fixture.document.outerPowerShellPath = powerShell;
      fixture.document.controllerPath = childPath;
      const result = await runBoundaryHarness([
        `$document=${quote(JSON.stringify(fixture.document))}|ConvertFrom-Json`,
        "$info=New-IntentArcPreflightControllerStartInfo -AuthorizationDocument $document",
        "$gate=New-IntentArcPreflightControllerLaunchGate -DurableConsumptionValidated $true",
        "$launch=[IntentArc.PreflightEnvelope.NativeProcessDispatcher]::Run([IntentArc.PreflightEnvelope.ProcessRole]::Controller,$info,(New-IntentArcPreflightControllerLaunchBindings $document),$gate,$null)",
        "$capture=Receive-IntentArcPreflightControllerOutput -Supervisor $launch.supervisor -MaximumStdoutBytes 1048576 -MaximumStderrBytes 1048576",
        "[ordered]@{launchKeys=@($launch.PSObject.Properties.Name);processCreated=$launch.processCreated;setupCategory=$launch.setupCategory;captureKeys=@($capture.PSObject.Properties.Name);stdoutBase64=[Convert]::ToBase64String($capture.stdout);stdoutBytes=$capture.stdoutBytes;stdoutSha256=$capture.stdoutSha256;stderrBytes=$capture.stderrBytes;stderrSha256=$capture.stderrSha256;stdoutOverflow=$capture.stdoutOverflow;stderrOverflow=$capture.stderrOverflow;captureJson=($capture|ConvertTo-Json -Compress -Depth 4)}|ConvertTo-Json -Compress -Depth 8",
      ].join("\n"));
      expect(result.launchKeys).toEqual(["processCreated", "nonCreationProven", "supervisor", "supervisorIdentityValid", "drainsInitialized", "setupCategory"]);
      expect(result.processCreated).toBe(true);
      expect(result.setupCategory).toBe("none");
      expect(result.captureKeys).toEqual(["stdout", "stdoutBytes", "stdoutSha256", "stderrBytes", "stderrSha256", "stdoutOverflow", "stderrOverflow"]);
      expect(result.stdoutBase64).toBe(stdout.toString("base64"));
      expect(result.stdoutBytes).toBe(stdout.length);
      expect(result.stdoutSha256).toBe(sha256(stdout));
      expect(result.stderrBytes).toBe(stderr.length);
      expect(result.stderrSha256).toBe(sha256(stderr));
      expect(result.stdoutOverflow).toBe(false);
      expect(result.stderrOverflow).toBe(false);
      expect(result.captureJson).not.toContain("sensitive-stderr");
    } finally { await disposeFixture(fixture); }
  });

  it("accepts only the exact 21-key attempt receipt success row", async () => {
    const receipt = {
      schema: "intentarc.preflight-execution-attempt-receipt/v1", attemptId: "phase1-preflight-envelope-20260902-01",
      controllerRunId: "phase1-preflight-20260901-06", launchAttemptedAtUtc: "2026-09-02T00:00:00.000Z",
      controllerStartedAtUtc: "2026-09-02T00:00:01.000Z", controllerProcessId: 4242,
      controllerStartTimeUtc: "2026-09-02T00:00:00.500Z", captureCompletedAtUtc: "2026-09-02T00:00:02.000Z",
      controllerExitedAtUtc: "2026-09-02T00:00:02.000Z", controllerExitCode: 0,
      stdoutBytes: 2, stdoutSha256: sha256("{}"), stderrBytes: 0, stderrSha256: sha256(Buffer.alloc(0)),
      stdoutOverflow: false, stderrOverflow: false, stdoutEof: true, stderrEof: true, processSettled: true,
      infrastructureCategory: "none", recordedAtUtc: "2026-09-02T00:00:03.000Z",
    };
    const result = await runBoundaryHarness([
      `$receipt=${quote(JSON.stringify(receipt))}|ConvertFrom-Json`,
      "$valid=Test-IntentArcPreflightAttemptReceipt -Document $receipt",
      "$receipt.stdoutOverflow=$true",
      "$mutant=Test-IntentArcPreflightAttemptReceipt -Document $receipt",
      "[ordered]@{keys=@($receipt.PSObject.Properties.Name);valid=$valid;mutant=$mutant}|ConvertTo-Json -Compress -Depth 4",
    ].join("\n"));
    expect(result.keys).toEqual(Object.keys(receipt));
    expect(result.valid).toBe(true);
    expect(result.mutant).toBe(false);
  });

  it("runs repeatable read-only exact Git observations through the shared dispatcher", async () => {
    const fixture = await createFixture();
    try {
      fixture.document.canonicalPath = repositoryRoot;
      fixture.document.gitPath = "C:\\Program Files\\Git\\cmd\\git.exe";
      const result = await runBoundaryHarness([
        `$document=${quote(JSON.stringify(fixture.document))}|ConvertFrom-Json`,
        "$first=Invoke-IntentArcPreflightGitObservation -AuthorizationDocument $document -Observation 'head'",
        "$second=Invoke-IntentArcPreflightGitObservation -AuthorizationDocument $document -Observation 'head'",
        "[ordered]@{firstKeys=@($first.PSObject.Properties.Name);firstText=$first.stdoutText;firstBytes=$first.stdoutBytes;firstStderr=$first.stderrBytes;firstExit=$first.exitCode;secondText=$second.stdoutText;secondExit=$second.exitCode}|ConvertTo-Json -Compress -Depth 4",
      ].join("\n"));
      expect(result.firstKeys).toEqual(["stdoutText", "stdoutBytes", "stdoutSha256", "stderrBytes", "stderrSha256", "exitCode"]);
      expect(result.firstText).toMatch(/^[0-9a-f]{40}\r?\n$/);
      expect(result.secondText).toBe(result.firstText);
      expect(result.firstBytes).toBe(Buffer.byteLength(result.firstText as string));
      expect(result.firstStderr).toBe(0);
      expect(result.firstExit).toBe(0);
      expect(result.secondExit).toBe(0);
    } finally { await disposeFixture(fixture); }
  });

  it.each([
    ["supervisor-identity", false, true, "supervisor-identity-invalid"],
    ["drain-initialization", true, false, "drain-initialization-invalid"],
    ["identity-and-drain", false, false, "supervisor-identity-invalid"],
    ["cancellation-after-creation", true, false, "drain-initialization-invalid"],
  ] as const)("returns the created-process supervisor for %s setup", async (fault, identity, drains, category) => {
    const fixture = await createFixture();
    try {
      const scripts = join(fixture.root, "scripts");
      await mkdir(scripts);
      const childPath = join(scripts, "desktop-release-preflight-out-preservation.ps1");
      await writeFile(childPath, "param([switch]$Execute,[string]$ExpectedCommit,[string]$PnpmExecutable,[string]$ExpectedPnpmSha256)\n", "utf8");
      fixture.document.outerPowerShellPath = powerShell;
      fixture.document.controllerPath = childPath;
      const result = await runBoundaryHarness([
        `$document=${quote(JSON.stringify(fixture.document))}|ConvertFrom-Json`,
        "$info=New-IntentArcPreflightControllerStartInfo -AuthorizationDocument $document",
        "$gate=New-IntentArcPreflightControllerLaunchGate -DurableConsumptionValidated $true",
        `$launch=[IntentArc.PreflightEnvelope.NativeProcessDispatcher]::Run([IntentArc.PreflightEnvelope.ProcessRole]::Controller,$info,(New-IntentArcPreflightControllerLaunchBindings $document),$gate,${quote(fault)})`,
        "$capture=$null;try{$capture=Receive-IntentArcPreflightControllerOutput -Supervisor $launch.supervisor -MaximumStdoutBytes 1048576 -MaximumStderrBytes 1048576}catch{}",
        "[ordered]@{created=$launch.processCreated;nonCreation=$launch.nonCreationProven;supervisor=($null-ne$launch.supervisor);pid=$launch.supervisor.processId;identity=$launch.supervisorIdentityValid;drains=$launch.drainsInitialized;category=$launch.setupCategory;captured=($null-ne$capture)}|ConvertTo-Json -Compress",
      ].join("\n"));
      expect(result).toEqual({ created: true, nonCreation: false, supervisor: true, pid: expect.any(Number), identity, drains, category, captured: true });
    } finally { await disposeFixture(fixture); }
  });

  it.each([[1048576, false], [1048577, true]] as const)("counts and hashes all %s stdout bytes with overflow=%s", async (count, overflow) => {
    const fixture = await createFixture();
    try {
      const scripts = join(fixture.root, "scripts");
      await mkdir(scripts);
      const childPath = join(scripts, "desktop-release-preflight-out-preservation.ps1");
      await writeFile(childPath, `param([switch]$Execute,[string]$ExpectedCommit,[string]$PnpmExecutable,[string]$ExpectedPnpmSha256)\n$bytes=[byte[]]::new(${count});for($i=0;$i-lt$bytes.Length;$i++){$bytes[$i]=97};$out=[Console]::OpenStandardOutput();$out.Write($bytes,0,$bytes.Length);$out.Flush()`, "utf8");
      fixture.document.outerPowerShellPath = powerShell;
      fixture.document.controllerPath = childPath;
      const expected = Buffer.alloc(count, 97);
      const result = await runBoundaryHarness([
        `$document=${quote(JSON.stringify(fixture.document))}|ConvertFrom-Json`,
        "$info=New-IntentArcPreflightControllerStartInfo -AuthorizationDocument $document;$gate=New-IntentArcPreflightControllerLaunchGate -DurableConsumptionValidated $true",
        "$launch=[IntentArc.PreflightEnvelope.NativeProcessDispatcher]::Run([IntentArc.PreflightEnvelope.ProcessRole]::Controller,$info,(New-IntentArcPreflightControllerLaunchBindings $document),$gate,$null)",
        "$capture=Receive-IntentArcPreflightControllerOutput -Supervisor $launch.supervisor -MaximumStdoutBytes 1048576 -MaximumStderrBytes 1048576",
        "[ordered]@{bytes=$capture.stdoutBytes;retained=$capture.stdout.Length;hash=$capture.stdoutSha256;overflow=$capture.stdoutOverflow;stderrHash=$capture.stderrSha256}|ConvertTo-Json -Compress",
      ].join("\n"));
      expect(result).toEqual({ bytes: count, retained: 1048576, hash: sha256(expected), overflow, stderrHash: sha256(Buffer.alloc(0)) });
    } finally { await disposeFixture(fixture); }
  }, 30_000);

  it("persists exact bounded stdout and the immutable validated attempt receipt without stderr text", async () => {
    const fixture = await createFixture();
    const evidenceParent = join(fixture.root, "evidence");
    await mkdir(evidenceParent);
    const stdout = Buffer.from("{\"status\":\"fixture\"}\r\n", "utf8");
    const receipt = {
      schema: "intentarc.preflight-execution-attempt-receipt/v1", attemptId: "phase1-preflight-envelope-20260902-01",
      controllerRunId: "phase1-preflight-20260901-06", launchAttemptedAtUtc: "2026-09-02T00:00:00.000Z",
      controllerStartedAtUtc: "2026-09-02T00:00:01.000Z", controllerProcessId: 4242,
      controllerStartTimeUtc: "2026-09-02T00:00:00.500Z", captureCompletedAtUtc: "2026-09-02T00:00:02.000Z",
      controllerExitedAtUtc: "2026-09-02T00:00:02.000Z", controllerExitCode: 0,
      stdoutBytes: stdout.length, stdoutSha256: sha256(stdout), stderrBytes: 17, stderrSha256: sha256("private-error-text"),
      stdoutOverflow: false, stderrOverflow: false, stdoutEof: true, stderrEof: true, processSettled: true,
      infrastructureCategory: "none", recordedAtUtc: "2026-09-02T00:00:03.000Z",
    };
    try {
      const result = await runBoundaryHarness([
        `$root=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::CreateExclusiveRoot(${quote(evidenceParent)},'attempt')`,
        `$capture=[pscustomobject][ordered]@{stdout=[Convert]::FromBase64String(${quote(stdout.toString("base64"))});stdoutBytes=[long]${stdout.length};stdoutSha256=${quote(sha256(stdout))};stderrBytes=[long]17;stderrSha256=${quote(sha256("private-error-text"))};stdoutOverflow=$false;stderrOverflow=$false}`,
        `$receipt=${quote(JSON.stringify(receipt))}|ConvertFrom-Json`,
        "try{$stdoutResult=Write-IntentArcPreflightCapturedControllerOutput -RootGuard $root -Capture $capture;$receiptResult=Write-IntentArcPreflightEnvelopeAttemptReceipt -RootGuard $root -Document $receipt;[ordered]@{stdoutHash=$stdoutResult.sha256;receiptHash=$receiptResult.sha256}|ConvertTo-Json -Compress}finally{$root.Dispose()}",
      ].join("\n"));
      expect(result.stdoutHash).toBe(sha256(stdout));
      expect(await readFile(join(evidenceParent, "attempt", "controller-stdout.json"))).toEqual(stdout);
      const persistedReceipt = await readFile(join(evidenceParent, "attempt", "attempt-receipt.json"), "utf8");
      expect(persistedReceipt).toBe(JSON.stringify(receipt));
      expect(persistedReceipt).not.toContain("private-error-text");
    } finally { await disposeFixture(fixture); }
  });

  it("persists byte-exact empty controller stdout after EOF", async () => {
    const fixture = await createFixture();
    const evidenceParent = join(fixture.root, "empty-evidence");
    await mkdir(evidenceParent);
    try {
      const result = await runBoundaryHarness([
        `$root=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::CreateExclusiveRoot(${quote(evidenceParent)},'attempt')`,
        `$capture=[pscustomobject][ordered]@{stdout=[byte[]]::new(0);stdoutBytes=[long]0;stdoutSha256=${quote(sha256(Buffer.alloc(0)))};stderrBytes=[long]0;stderrSha256=${quote(sha256(Buffer.alloc(0)))};stdoutOverflow=$false;stderrOverflow=$false}`,
        "try{$written=Write-IntentArcPreflightCapturedControllerOutput -RootGuard $root -Capture $capture;[ordered]@{sha256=$written.sha256}|ConvertTo-Json -Compress}finally{$root.Dispose()}",
      ].join("\n"));
      expect(result.sha256).toBe(sha256(Buffer.alloc(0)));
      expect(await readFile(join(evidenceParent, "attempt", "controller-stdout.json"))).toEqual(Buffer.alloc(0));
    } finally { await disposeFixture(fixture); }
  });

  it("enforces the exhaustive attempt receipt category, timestamp, count, hash, EOF, overflow, and settlement matrix", async () => {
    const emptyHash = sha256(Buffer.alloc(0));
    const base = {
      schema: "intentarc.preflight-execution-attempt-receipt/v1", attemptId: "phase1-preflight-envelope-20260902-01",
      controllerRunId: "phase1-preflight-20260901-06", launchAttemptedAtUtc: "2026-09-02T00:00:00.000Z",
      controllerStartedAtUtc: "2026-09-02T00:00:01.000Z", controllerProcessId: 4242,
      controllerStartTimeUtc: "2026-09-02T00:00:00.500Z", captureCompletedAtUtc: "2026-09-02T00:00:02.000Z",
      controllerExitedAtUtc: "2026-09-02T00:00:02.000Z", controllerExitCode: 0,
      stdoutBytes: 0, stdoutSha256: emptyHash, stderrBytes: 0, stderrSha256: emptyHash,
      stdoutOverflow: false, stderrOverflow: false, stdoutEof: true, stderrEof: true, processSettled: true,
      infrastructureCategory: "none", recordedAtUtc: "2026-09-02T00:00:03.000Z",
    };
    const launchFailure = { ...base, controllerStartedAtUtc: null, controllerProcessId: null, controllerStartTimeUtc: null, captureCompletedAtUtc: null, controllerExitedAtUtc: null, controllerExitCode: null, stdoutSha256: null, stderrSha256: null, stdoutEof: false, stderrEof: false, processSettled: false, infrastructureCategory: "launch-failed" };
    const identityInvalid = { ...launchFailure, infrastructureCategory: "settlement-invalid" };
    const journalInvalid = { ...base, infrastructureCategory: "consumption-journal-invalid" };
    const settlementInvalid = { ...base, controllerExitedAtUtc: null, controllerExitCode: null, processSettled: false, infrastructureCategory: "settlement-invalid" };
    const captureInvalid = { ...base, captureCompletedAtUtc: null, stdoutSha256: null, stdoutEof: false, infrastructureCategory: "capture-invalid" };
    const captureInitializationInvalid = { ...base, infrastructureCategory: "capture-invalid" };
    const overflow = { ...base, stdoutBytes: 1048577, stdoutOverflow: true, infrastructureCategory: "capture-overflow" };
    const valid = [launchFailure, identityInvalid, journalInvalid, settlementInvalid, captureInvalid, captureInitializationInvalid, overflow, base];
    const mutants: Record<string, unknown>[] = [
      { ...base, extra: true },
      Object.fromEntries(Object.entries(base).slice().reverse()),
      Object.fromEntries(Object.entries(base).filter(([key]) => key !== "recordedAtUtc")),
      { ...base, schema: "wrong" }, { ...base, attemptId: "wrong" }, { ...base, controllerRunId: "wrong" },
      { ...base, launchAttemptedAtUtc: "2026-09-02T00:00:04.000Z" },
      { ...base, controllerStartTimeUtc: "2026-09-01T23:59:59.999Z" },
      { ...base, controllerStartedAtUtc: "2026-09-02T00:00:00.250Z" },
      { ...base, captureCompletedAtUtc: "2026-09-02T00:00:00.750Z" },
      { ...base, controllerExitedAtUtc: "2026-09-02T00:00:00.250Z" },
      { ...base, recordedAtUtc: "2026-09-02T00:00:01.500Z" },
      { ...base, stdoutBytes: -1 }, { ...base, stdoutBytes: 1.5 }, { ...base, stdoutBytes: "0" },
      { ...base, stdoutBytes: 9007199254740992 }, { ...base, stdoutOverflow: true },
      { ...base, stdoutEof: false }, { ...base, stdoutSha256: null },
      { ...captureInvalid, captureCompletedAtUtc: base.captureCompletedAtUtc },
      { ...base, processSettled: false }, { ...base, controllerExitCode: null },
      { ...launchFailure, stdoutBytes: 1 }, { ...identityInvalid, controllerProcessId: 42 },
      { ...base, infrastructureCategory: "capture-overflow" },
      { ...overflow, infrastructureCategory: "none" },
      { ...base, infrastructureCategory: "unknown" },
    ];
    const rows = [...valid.map((document) => ({ document, want: true })), ...mutants.map((document) => ({ document, want: false }))];
    const result = await runBoundaryHarness([
      `$rows=${quote(JSON.stringify(rows))}|ConvertFrom-Json`,
      "$actual=@();foreach($row in $rows){$actual+=Test-IntentArcPreflightAttemptReceipt -Document $row.document}",
      "[ordered]@{actual=@($actual)}|ConvertTo-Json -Compress",
    ].join("\n"));
    expect(result.actual).toEqual(rows.map((row) => row.want));
  });

  it("rejects controller vector, environment, shell, working-directory, role, and cardinality mutants before a second process creation", async () => {
    const fixture = await createFixture();
    try {
      const scripts = join(fixture.root, "scripts");
      await mkdir(scripts);
      const childPath = join(scripts, "desktop-release-preflight-out-preservation.ps1");
      await writeFile(childPath, "param([switch]$Execute,[string]$ExpectedCommit,[string]$PnpmExecutable,[string]$ExpectedPnpmSha256)\n", "utf8");
      fixture.document.outerPowerShellPath = powerShell;
      fixture.document.controllerPath = childPath;
      const result = await runBoundaryHarness([
        `$document=${quote(JSON.stringify(fixture.document))}|ConvertFrom-Json`,
        "$mutations=@('shell','executable','working-directory','restore-only','extra-token','environment','redirect')",
        "$accepted=[Collections.Generic.List[string]]::new();foreach($mutation in $mutations){$info=New-IntentArcPreflightControllerStartInfo -AuthorizationDocument $document;$bindings=New-IntentArcPreflightControllerLaunchBindings $document;switch($mutation){'shell'{$info.UseShellExecute=$true};'executable'{$info.FileName='C:\\Windows\\System32\\cmd.exe'};'working-directory'{$info.WorkingDirectory='C:\\Windows'};'restore-only'{$info.Arguments=$info.Arguments.Replace('-Execute','-RestoreOnly')};'extra-token'{$info.Arguments+=' -NoLogo'};'environment'{$info.EnvironmentVariables['PATH']='forbidden'};'redirect'{$info.RedirectStandardError=$false}};$gate=New-IntentArcPreflightControllerLaunchGate -DurableConsumptionValidated $true;try{$launch=[IntentArc.PreflightEnvelope.NativeProcessDispatcher]::Run([IntentArc.PreflightEnvelope.ProcessRole]::Controller,$info,$bindings,$gate,$null);[void]$accepted.Add($mutation);if($null-ne$launch.supervisor){try{[void](Receive-IntentArcPreflightControllerOutput -Supervisor $launch.supervisor -MaximumStdoutBytes 1048576 -MaximumStderrBytes 1048576)}catch{}}}catch{}}",
        "$info=New-IntentArcPreflightControllerStartInfo -AuthorizationDocument $document;$bindings=New-IntentArcPreflightControllerLaunchBindings $document;$gate=New-IntentArcPreflightControllerLaunchGate -DurableConsumptionValidated $true;$first=[IntentArc.PreflightEnvelope.NativeProcessDispatcher]::Run([IntentArc.PreflightEnvelope.ProcessRole]::Controller,$info,$bindings,$gate,$null);$secondBlocked=$false;try{[void][IntentArc.PreflightEnvelope.NativeProcessDispatcher]::Run([IntentArc.PreflightEnvelope.ProcessRole]::Controller,$info,$bindings,$gate,$null)}catch{$secondBlocked=$true};[void](Receive-IntentArcPreflightControllerOutput -Supervisor $first.supervisor -MaximumStdoutBytes 1048576 -MaximumStderrBytes 1048576)",
        "[ordered]@{accepted=@($accepted);secondBlocked=$secondBlocked}|ConvertTo-Json -Compress",
      ].join("\n"));
      expect(result).toEqual({ accepted: [], secondBlocked: true });
    } finally { await disposeFixture(fixture); }
  });

  it("rejects unbounded or drifting Git-role vectors before process creation", async () => {
    const fixture = await createFixture();
    try {
      fixture.document.canonicalPath = repositoryRoot;
      fixture.document.gitPath = "C:\\Program Files\\Git\\cmd\\git.exe";
      fixture.document.outerPowerShellPath = powerShell;
      const result = await runBoundaryHarness([
        `$document=${quote(JSON.stringify(fixture.document))}|ConvertFrom-Json`,
        "$mutations=@('untracked','optional-lock','config','subcommand','root','environment','controller-vector')",
        "$accepted=[Collections.Generic.List[string]]::new();$bindings=New-IntentArcPreflightGitObservationBindings $document;foreach($mutation in $mutations){if($mutation-ceq'controller-vector'){$info=New-IntentArcPreflightControllerStartInfo -AuthorizationDocument $document}else{$info=New-IntentArcPreflightGitObservationStartInfo -AuthorizationDocument $document -Observation 'status';switch($mutation){'untracked'{$info.Arguments=$info.Arguments.Replace('--untracked-files=no','--untracked-files=all')};'optional-lock'{$info.Arguments=$info.Arguments.Replace('--no-optional-locks','--optional-locks')};'config'{$info.Arguments=$info.Arguments.Replace('core.fsmonitor=false','core.fsmonitor=true')};'subcommand'{$info.Arguments=$info.Arguments.Replace('status','log')};'root'{$info.WorkingDirectory='C:\\Windows'};'environment'{$info.EnvironmentVariables['PATH']='forbidden'}}};try{[void][IntentArc.PreflightEnvelope.NativeProcessDispatcher]::Run([IntentArc.PreflightEnvelope.ProcessRole]::GitObservation,$info,$bindings,$null,$null);[void]$accepted.Add($mutation)}catch{}};[ordered]@{accepted=@($accepted)}|ConvertTo-Json -Compress",
      ].join("\n"));
      expect(result).toEqual({ accepted: [] });
    } finally { await disposeFixture(fixture); }
  });

  it.each([
    ["normal", null, true, null, "none", true],
    ["controller-started-write-failed", null, false, null, "consumption-journal-invalid", true],
    ["drain-initialization", "drain-initialization", true, null, "capture-invalid", true],
    ["supervisor-identity", "supervisor-identity", false, null, "settlement-invalid", false],
    ["later-cancellation", null, true, "later-cancellation", "capture-invalid", true],
    ["drain-failure", null, true, "drain-failure", "capture-invalid", true],
    ["settlement-uncertain", null, true, "settlement-uncertain", "settlement-invalid", true],
  ] as const)("finalizes one created process into the exact attempt receipt for %s", async (_name, setupFault, controllerStartedValid, finalizationFault, category, stdoutPersisted) => {
    const fixture = await createFixture();
    const evidenceParent = join(fixture.root, "finalizer-evidence");
    const scripts = join(fixture.root, "scripts");
    await mkdir(evidenceParent); await mkdir(scripts);
    try {
      const childPath = join(scripts, "desktop-release-preflight-out-preservation.ps1");
      await writeFile(childPath, "param([switch]$Execute,[string]$ExpectedCommit,[string]$PnpmExecutable,[string]$ExpectedPnpmSha256)\n[Console]::Out.Write('{}')\n", "utf8");
      fixture.document.outerPowerShellPath = powerShell;
      fixture.document.controllerPath = childPath;
      const result = await runBoundaryHarness([
        `$document=${quote(JSON.stringify(fixture.document))}|ConvertFrom-Json`,
        `$root=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::CreateExclusiveRoot(${quote(evidenceParent)},'attempt')`,
        "$launchAt=[DateTimeOffset]::UtcNow.ToString(\"yyyy-MM-ddTHH:mm:ss.fff'Z'\",[Globalization.CultureInfo]::InvariantCulture)",
        "$info=New-IntentArcPreflightControllerStartInfo -AuthorizationDocument $document;$gate=New-IntentArcPreflightControllerLaunchGate -DurableConsumptionValidated $true",
        `$launch=[IntentArc.PreflightEnvelope.NativeProcessDispatcher]::Run([IntentArc.PreflightEnvelope.ProcessRole]::Controller,$info,(New-IntentArcPreflightControllerLaunchBindings $document),$gate,${setupFault === null ? "$null" : quote(setupFault)})`,
        `try{$final=Finalize-IntentArcPreflightControllerAttempt -RootGuard $root -Launch $launch -ControllerStartedValid $${controllerStartedValid} -LaunchAttemptedAtUtc $launchAt${finalizationFault === null ? "" : ` -Fault ${quote(finalizationFault)}`};$receipt=[IO.File]::ReadAllText((Join-Path ${quote(join(evidenceParent, "attempt"))} 'attempt-receipt.json'))|ConvertFrom-Json;[ordered]@{finalized=$final.finalized;category=$receipt.infrastructureCategory;stdoutPersisted=[IO.File]::Exists((Join-Path ${quote(join(evidenceParent, "attempt"))} 'controller-stdout.json'));receiptKeys=@($receipt.PSObject.Properties.Name);stderrTextPresent=([IO.File]::ReadAllText((Join-Path ${quote(join(evidenceParent, "attempt"))} 'attempt-receipt.json')).Contains('sensitive-stderr'))}|ConvertTo-Json -Compress -Depth 4}finally{$root.Dispose()}`,
      ].join("\n"));
      expect(result.finalized).toBe(true);
      expect(result.category).toBe(category);
      expect(result.stdoutPersisted).toBe(stdoutPersisted);
      expect(result.receiptKeys).toHaveLength(21);
      expect(result.stderrTextPresent).toBe(false);
    } finally { await disposeFixture(fixture); }
  });

  it("writes launch-failed only from a closed pre-creation non-creation proof", async () => {
    const fixture = await createFixture();
    const evidenceParent = join(fixture.root, "launch-failed-evidence");
    const scripts = join(fixture.root, "scripts");
    await mkdir(evidenceParent); await mkdir(scripts);
    try {
      fixture.document.outerPowerShellPath = powerShell;
      fixture.document.controllerPath = join(scripts, "desktop-release-preflight-out-preservation.ps1");
      await writeFile(fixture.document.controllerPath, "throw 'must-not-run'\n", "utf8");
      const result = await runBoundaryHarness([
        `$document=${quote(JSON.stringify(fixture.document))}|ConvertFrom-Json`,
        `$root=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::CreateExclusiveRoot(${quote(evidenceParent)},'attempt')`,
        "$launchAt=[DateTimeOffset]::UtcNow.ToString(\"yyyy-MM-ddTHH:mm:ss.fff'Z'\",[Globalization.CultureInfo]::InvariantCulture)",
        "$info=New-IntentArcPreflightControllerStartInfo -AuthorizationDocument $document;$gate=New-IntentArcPreflightControllerLaunchGate -DurableConsumptionValidated $true",
        "$launch=[IntentArc.PreflightEnvelope.NativeProcessDispatcher]::Run([IntentArc.PreflightEnvelope.ProcessRole]::Controller,$info,(New-IntentArcPreflightControllerLaunchBindings $document),$gate,'pre-creation-failure')",
        `try{$final=Finalize-IntentArcPreflightControllerAttempt -RootGuard $root -Launch $launch -ControllerStartedValid $false -LaunchAttemptedAtUtc $launchAt;$receipt=[IO.File]::ReadAllText(${quote(join(evidenceParent, "attempt", "attempt-receipt.json"))})|ConvertFrom-Json;[ordered]@{launch=@($launch.processCreated,$launch.nonCreationProven,($null-eq$launch.supervisor),$launch.supervisorIdentityValid,$launch.drainsInitialized,$launch.setupCategory);category=$receipt.infrastructureCategory;finalized=$final.finalized;stdout=[IO.File]::Exists(${quote(join(evidenceParent, "attempt", "controller-stdout.json"))})}|ConvertTo-Json -Compress}finally{$root.Dispose()}`,
      ].join("\n"));
      expect(result).toEqual({ launch: [false, true, true, false, false, "launch-failed"], category: "launch-failed", finalized: true, stdout: false });
    } finally { await disposeFixture(fixture); }
  });

  it.each([
    ["host-loss-before-receipt", true, false],
    ["host-loss-after-receipt", true, true],
  ] as const)("models %s without recovery or relaunch", async (fault, stdoutExists, receiptExists) => {
    const fixture = await createFixture();
    const evidenceParent = join(fixture.root, `host-loss-${fault}`);
    const scripts = join(fixture.root, "scripts");
    await mkdir(evidenceParent); await mkdir(scripts);
    try {
      fixture.document.outerPowerShellPath = powerShell;
      fixture.document.controllerPath = join(scripts, "desktop-release-preflight-out-preservation.ps1");
      await writeFile(fixture.document.controllerPath, "param([switch]$Execute,[string]$ExpectedCommit,[string]$PnpmExecutable,[string]$ExpectedPnpmSha256)\n[Console]::Out.Write('{}')\n", "utf8");
      const result = await runBoundaryHarness([
        `$document=${quote(JSON.stringify(fixture.document))}|ConvertFrom-Json`,
        `$root=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::CreateExclusiveRoot(${quote(evidenceParent)},'attempt')`,
        "$launchAt=[DateTimeOffset]::UtcNow.ToString(\"yyyy-MM-ddTHH:mm:ss.fff'Z'\",[Globalization.CultureInfo]::InvariantCulture)",
        "$info=New-IntentArcPreflightControllerStartInfo -AuthorizationDocument $document;$gate=New-IntentArcPreflightControllerLaunchGate -DurableConsumptionValidated $true",
        "$launch=[IntentArc.PreflightEnvelope.NativeProcessDispatcher]::Run([IntentArc.PreflightEnvelope.ProcessRole]::Controller,$info,(New-IntentArcPreflightControllerLaunchBindings $document),$gate,$null)",
        `$threw=$false;try{[void](Finalize-IntentArcPreflightControllerAttempt -RootGuard $root -Launch $launch -ControllerStartedValid $true -LaunchAttemptedAtUtc $launchAt -Fault ${quote(fault)})}catch{$threw=$true};[ordered]@{threw=$threw;stdout=[IO.File]::Exists(${quote(join(evidenceParent, "attempt", "controller-stdout.json"))});receipt=[IO.File]::Exists(${quote(join(evidenceParent, "attempt", "attempt-receipt.json"))})}|ConvertTo-Json -Compress;$root.Dispose()`,
      ].join("\n"));
      expect(result).toEqual({ threw: true, stdout: stdoutExists, receipt: receiptExists });
    } finally { await disposeFixture(fixture); }
  });

  it.each([
    ["nonzero", "[Console]::Out.Write('nonzero');exit 17", 17, 0, false],
    ["abrupt", "[Console]::Out.Flush();Stop-Process -Id $PID -Force", expect.any(Number), 0, false],
    ["stderr-overflow", "$bytes=[byte[]]::new(1048577);$err=[Console]::OpenStandardError();$err.Write($bytes,0,$bytes.Length);$err.Flush()", 0, 1048577, true],
  ] as const)("settles and reaches EOF for %s fixture", async (_name, body, exitCode, stderrBytes, stderrOverflow) => {
    const fixture = await createFixture();
    const scripts = join(fixture.root, "scripts");
    await mkdir(scripts);
    try {
      fixture.document.outerPowerShellPath = powerShell;
      fixture.document.controllerPath = join(scripts, "desktop-release-preflight-out-preservation.ps1");
      await writeFile(fixture.document.controllerPath, `param([switch]$Execute,[string]$ExpectedCommit,[string]$PnpmExecutable,[string]$ExpectedPnpmSha256)\n${body}\n`, "utf8");
      const result = await runBoundaryHarness([
        `$document=${quote(JSON.stringify(fixture.document))}|ConvertFrom-Json`,
        "$info=New-IntentArcPreflightControllerStartInfo -AuthorizationDocument $document;$gate=New-IntentArcPreflightControllerLaunchGate -DurableConsumptionValidated $true",
        "$launch=[IntentArc.PreflightEnvelope.NativeProcessDispatcher]::Run([IntentArc.PreflightEnvelope.ProcessRole]::Controller,$info,(New-IntentArcPreflightControllerLaunchBindings $document),$gate,$null)",
        "$capture=Receive-IntentArcPreflightControllerOutput -Supervisor $launch.supervisor -MaximumStdoutBytes 1048576 -MaximumStderrBytes 1048576",
        "$exit=[IntentArc.PreflightEnvelope.NativeProcessDispatcher]::GetSettledExitCode($launch.supervisor)",
        "[ordered]@{exit=$exit;stderrBytes=$capture.stderrBytes;stderrOverflow=$capture.stderrOverflow;stderrHash=$capture.stderrSha256;stdoutHash=$capture.stdoutSha256}|ConvertTo-Json -Compress",
      ].join("\n"));
      expect(result.exit).toEqual(exitCode);
      expect(result.stderrBytes).toBe(stderrBytes);
      expect(result.stderrOverflow).toBe(stderrOverflow);
      expect(result.stderrHash).toMatch(/^[0-9a-f]{64}$/);
      expect(result.stdoutHash).toMatch(/^[0-9a-f]{64}$/);
    } finally { await disposeFixture(fixture); }
  }, 30_000);

  it("keeps one closed dispatcher and kills launch, capture, environment, and role source mutants", async () => {
    const source = await readFile(scriptPath, "utf8");
    expect(task4ProcessViolations(source)).toEqual([]);
    const mutants = [
      source.replace("$info.UseShellExecute = $false", "$info.UseShellExecute = $true"),
      source.replace("created = process.Start();", "created = process.Start();\n        created = process.Start();"),
      source.replace("stdout = stdoutCapture.Retained;", "stdout = Encoding.UTF8.GetBytes(Encoding.UTF8.GetString(stdoutCapture.Retained));"),
      source.replace("stderrBytes = stderrCapture.Count;", "stderr = stderrCapture.Retained; stderrBytes = stderrCapture.Count;"),
      source.replace("Overflow = count > MaximumCaptureBytes", "Overflow = count >= MaximumCaptureBytes"),
      source.replace("return Task.Run(() => {", "return Task.FromResult(new NativeStreamCapture()); //"),
      source.replace("$info.WorkingDirectory = $WorkingDirectory", "$info.WorkingDirectory = 'C:\\Windows'"),
      source.replace("'-Execute', '-ExpectedCommit'", "'-RestoreOnly', '-ExpectedCommit'"),
      source.replace("$StartInfo.EnvironmentVariables.Clear()", "$null = $StartInfo.EnvironmentVariables.Count"),
      source.replace("public enum ProcessRole { GitObservation, Controller }", "public enum ProcessRole { GitObservation, Controller, Arbitrary }"),
      source.replace('stderrTask = DrainAsync(process.StandardError.BaseStream, false, setupFault == "stderr-mid-drain-failure",', 'stderrTask = DrainAsync(process.StandardError.BaseStream, true, setupFault == "stderr-mid-drain-failure",'),
      source.replace('arguments[7] == "HEAD"', 'arguments[7] == "HEAD" || arguments[7] == "log"'),
      source.replace("process.StartInfo = startInfo;", "process.StartInfo = startInfo; Process.Start('cmd.exe');"),
      source.replace('throw new InvalidOperationException("process-launch-uncertain");', 'return new NativeProcessLaunchResult(false, true, null, false, false, "launch-failed");'),
      source.replace("if (supervisor.StdoutTask == null || supervisor.StderrTask == null) throw new InvalidOperationException(\"capture-invalid\");", "if (false) throw new InvalidOperationException(\"capture-invalid\");"),
      source.replace("!supervisor.SettlementComplete", "!supervisor.ReceiveAttempted"),
      source.replace("public static NativeProcessCaptureResult GetAvailableCapture(NativeProcessSupervisor supervisor)", "public static NativeProcessCaptureResult GetDiscardedCapture(NativeProcessSupervisor supervisor)"),
      source.replace("ValidateStartInfo(role, startInfo, bindings);", "ValidateStartInfo(role, startInfo, null);"),
      source.replace("!String.Equals(arguments[6], bindings.ExpectedCommit, StringComparison.Ordinal)", "false"),
      source.replace("!String.Equals(arguments[10], bindings.PnpmSha256, StringComparison.Ordinal)", "false"),
    ];
    const survivors: number[] = [];
    mutants.forEach((mutant, index) => {
      expect(mutant, `Task4 mutant ${index + 1} must alter source`).not.toBe(source);
      if (task4ProcessViolations(mutant).length === 0) survivors.push(index + 1);
    });
    expect(survivors).toEqual([]);
  });

  it("does not convert an actual Process.Start exception into a non-creation proof", async () => {
    const fixture = await createFixture();
    const scripts = join(fixture.root, "scripts");
    await mkdir(scripts);
    try {
      fixture.document.outerPowerShellPath = powerShell;
      fixture.document.controllerPath = join(scripts, "desktop-release-preflight-out-preservation.ps1");
      await writeFile(fixture.document.controllerPath, "throw 'must-not-run'\n", "utf8");
      const result = await runBoundaryHarness([
        `$document=${quote(JSON.stringify(fixture.document))}|ConvertFrom-Json`,
        "$info=New-IntentArcPreflightControllerStartInfo -AuthorizationDocument $document;$gate=New-IntentArcPreflightControllerLaunchGate -DurableConsumptionValidated $true",
        "$launch=$null;$message=$null;try{$launch=[IntentArc.PreflightEnvelope.NativeProcessDispatcher]::Run([IntentArc.PreflightEnvelope.ProcessRole]::Controller,$info,(New-IntentArcPreflightControllerLaunchBindings $document),$gate,'process-start-exception')}catch{$message=$_.Exception.InnerException.Message}",
        "[ordered]@{threw=($null-ne$message);message=$message;launchReturned=($null-ne$launch)}|ConvertTo-Json -Compress",
      ].join("\n"));
      expect(result).toEqual({ threw: true, message: "process-launch-uncertain", launchReturned: false });
    } finally { await disposeFixture(fixture); }
  });

  it("returns a genuine partial drain-initialization fault without waiting for child exit", async () => {
    const fixture = await createFixture();
    const scripts = join(fixture.root, "scripts");
    const evidenceParent = join(fixture.root, "partial-drain-evidence");
    await mkdir(scripts); await mkdir(evidenceParent);
    try {
      fixture.document.outerPowerShellPath = powerShell;
      fixture.document.controllerPath = join(scripts, "desktop-release-preflight-out-preservation.ps1");
      await writeFile(fixture.document.controllerPath, "param([switch]$Execute,[string]$ExpectedCommit,[string]$PnpmExecutable,[string]$ExpectedPnpmSha256)\nStart-Sleep -Milliseconds 1500\n", "utf8");
      const result = await runBoundaryHarness([
        `$document=${quote(JSON.stringify(fixture.document))}|ConvertFrom-Json`,
        `$root=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::CreateExclusiveRoot(${quote(evidenceParent)},'attempt')`,
        "$launchAt=[DateTimeOffset]::UtcNow.ToString(\"yyyy-MM-ddTHH:mm:ss.fff'Z'\",[Globalization.CultureInfo]::InvariantCulture)",
        "$info=New-IntentArcPreflightControllerStartInfo -AuthorizationDocument $document;$gate=New-IntentArcPreflightControllerLaunchGate -DurableConsumptionValidated $true",
        "$launch=[IntentArc.PreflightEnvelope.NativeProcessDispatcher]::Run([IntentArc.PreflightEnvelope.ProcessRole]::Controller,$info,(New-IntentArcPreflightControllerLaunchBindings $document),$gate,'partial-drain-initialization')",
        `$clock=[Diagnostics.Stopwatch]::StartNew();try{$final=Finalize-IntentArcPreflightControllerAttempt -RootGuard $root -Launch $launch -ControllerStartedValid $true -LaunchAttemptedAtUtc $launchAt;$clock.Stop();$receipt=[IO.File]::ReadAllText(${quote(join(evidenceParent, "attempt", "attempt-receipt.json"))})|ConvertFrom-Json;[ordered]@{created=$launch.processCreated;identity=$launch.supervisorIdentityValid;drains=$launch.drainsInitialized;setupCategory=$launch.setupCategory;finalized=$final.finalized;receiptValid=Test-IntentArcPreflightAttemptReceipt $receipt;receiptCategory=$receipt.infrastructureCategory;settled=$receipt.processSettled;elapsedMs=$clock.ElapsedMilliseconds}|ConvertTo-Json -Compress}finally{$root.Dispose()}`,
      ].join("\n"));
      expect(result.created).toBe(true);
      expect(result.identity).toBe(true);
      expect(result.drains).toBe(false);
      expect(result.setupCategory).toBe("drain-initialization-invalid");
      expect(result.finalized).toBe(true);
      expect(result.receiptValid).toBe(true);
      expect(result.receiptCategory).toBe("settlement-invalid");
      expect(result.settled).toBe(false);
      expect(result.elapsedMs).toBeLessThan(750);
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 1800));
      await disposeFixture(fixture);
    }
  });

  it("records an injected WaitForExit exception as a valid settlement-invalid receipt", async () => {
    const fixture = await createFixture();
    const scripts = join(fixture.root, "scripts");
    const evidenceParent = join(fixture.root, "wait-failure-evidence");
    await mkdir(scripts); await mkdir(evidenceParent);
    try {
      fixture.document.outerPowerShellPath = powerShell;
      fixture.document.controllerPath = join(scripts, "desktop-release-preflight-out-preservation.ps1");
      await writeFile(fixture.document.controllerPath, "param([switch]$Execute,[string]$ExpectedCommit,[string]$PnpmExecutable,[string]$ExpectedPnpmSha256)\nStart-Sleep -Milliseconds 1000\n", "utf8");
      const result = await runBoundaryHarness([
        `$document=${quote(JSON.stringify(fixture.document))}|ConvertFrom-Json`,
        `$root=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::CreateExclusiveRoot(${quote(evidenceParent)},'attempt')`,
        "$launchAt=[DateTimeOffset]::UtcNow.ToString(\"yyyy-MM-ddTHH:mm:ss.fff'Z'\",[Globalization.CultureInfo]::InvariantCulture)",
        "$info=New-IntentArcPreflightControllerStartInfo -AuthorizationDocument $document;$gate=New-IntentArcPreflightControllerLaunchGate -DurableConsumptionValidated $true",
        "$launch=[IntentArc.PreflightEnvelope.NativeProcessDispatcher]::Run([IntentArc.PreflightEnvelope.ProcessRole]::Controller,$info,(New-IntentArcPreflightControllerLaunchBindings $document),$gate,'wait-for-exit')",
        `try{[void](Finalize-IntentArcPreflightControllerAttempt -RootGuard $root -Launch $launch -ControllerStartedValid $true -LaunchAttemptedAtUtc $launchAt);$receipt=[IO.File]::ReadAllText(${quote(join(evidenceParent, "attempt", "attempt-receipt.json"))})|ConvertFrom-Json;[ordered]@{valid=Test-IntentArcPreflightAttemptReceipt $receipt;category=$receipt.infrastructureCategory;settled=$receipt.processSettled;exit=$receipt.controllerExitCode;exitAt=$receipt.controllerExitedAtUtc;stdout=[IO.File]::Exists(${quote(join(evidenceParent, "attempt", "controller-stdout.json"))})}|ConvertTo-Json -Compress}finally{$root.Dispose()}`,
      ].join("\n"));
      expect(result).toEqual({ valid: true, category: "settlement-invalid", settled: false, exit: null, exitAt: null, stdout: true });
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 1300));
      await disposeFixture(fixture);
    }
  });

  it("retains exact available byte observations from a genuine mid-drain fault", async () => {
    const fixture = await createFixture();
    const scripts = join(fixture.root, "scripts");
    const evidenceParent = join(fixture.root, "drain-failure-evidence");
    await mkdir(scripts); await mkdir(evidenceParent);
    try {
      fixture.document.outerPowerShellPath = powerShell;
      fixture.document.controllerPath = join(scripts, "desktop-release-preflight-out-preservation.ps1");
      await writeFile(fixture.document.controllerPath, "param([switch]$Execute,[string]$ExpectedCommit,[string]$PnpmExecutable,[string]$ExpectedPnpmSha256)\n$bytes=[byte[]]::new(8192);for($i=0;$i-lt$bytes.Length;$i++){$bytes[$i]=98};$err=[Console]::OpenStandardError();$err.Write($bytes,0,$bytes.Length);$err.Flush()\n", "utf8");
      const result = await runBoundaryHarness([
        `$document=${quote(JSON.stringify(fixture.document))}|ConvertFrom-Json`,
        `$root=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::CreateExclusiveRoot(${quote(evidenceParent)},'attempt')`,
        "$launchAt=[DateTimeOffset]::UtcNow.ToString(\"yyyy-MM-ddTHH:mm:ss.fff'Z'\",[Globalization.CultureInfo]::InvariantCulture)",
        "$info=New-IntentArcPreflightControllerStartInfo -AuthorizationDocument $document;$gate=New-IntentArcPreflightControllerLaunchGate -DurableConsumptionValidated $true",
        "$launch=[IntentArc.PreflightEnvelope.NativeProcessDispatcher]::Run([IntentArc.PreflightEnvelope.ProcessRole]::Controller,$info,(New-IntentArcPreflightControllerLaunchBindings $document),$gate,'stderr-mid-drain-failure')",
        `try{[void](Finalize-IntentArcPreflightControllerAttempt -RootGuard $root -Launch $launch -ControllerStartedValid $true -LaunchAttemptedAtUtc $launchAt);$receipt=[IO.File]::ReadAllText(${quote(join(evidenceParent, "attempt", "attempt-receipt.json"))})|ConvertFrom-Json;[ordered]@{valid=Test-IntentArcPreflightAttemptReceipt $receipt;category=$receipt.infrastructureCategory;settled=$receipt.processSettled;stderrBytes=$receipt.stderrBytes;stderrHash=$receipt.stderrSha256;stderrEof=$receipt.stderrEof;stderrOverflow=$receipt.stderrOverflow;stdoutEof=$receipt.stdoutEof;stdoutPersisted=[IO.File]::Exists(${quote(join(evidenceParent, "attempt", "controller-stdout.json"))})}|ConvertTo-Json -Compress}finally{$root.Dispose()}`,
      ].join("\n"));
      expect(result).toEqual({ valid: true, category: "capture-invalid", settled: true, stderrBytes: 8192, stderrHash: null, stderrEof: false, stderrOverflow: false, stdoutEof: true, stdoutPersisted: true });
    } finally { await disposeFixture(fixture); }
  });

  it("retains the one available stream observation when a drain read aborts", async () => {
    const fixture = await createFixture();
    const scripts = join(fixture.root, "scripts");
    const evidenceParent = join(fixture.root, "drain-read-failure-evidence");
    await mkdir(scripts); await mkdir(evidenceParent);
    try {
      fixture.document.outerPowerShellPath = powerShell;
      fixture.document.controllerPath = join(scripts, "desktop-release-preflight-out-preservation.ps1");
      await writeFile(fixture.document.controllerPath, "param([switch]$Execute,[string]$ExpectedCommit,[string]$PnpmExecutable,[string]$ExpectedPnpmSha256)\n$bytes=[byte[]]::new(8192);for($i=0;$i-lt$bytes.Length;$i++){$bytes[$i]=99};$err=[Console]::OpenStandardError();$err.Write($bytes,0,$bytes.Length);$err.Flush()\n", "utf8");
      const result = await runBoundaryHarness([
        `$document=${quote(JSON.stringify(fixture.document))}|ConvertFrom-Json`,
        `$root=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::CreateExclusiveRoot(${quote(evidenceParent)},'attempt')`,
        "$launchAt=[DateTimeOffset]::UtcNow.ToString(\"yyyy-MM-ddTHH:mm:ss.fff'Z'\",[Globalization.CultureInfo]::InvariantCulture)",
        "$info=New-IntentArcPreflightControllerStartInfo -AuthorizationDocument $document;$gate=New-IntentArcPreflightControllerLaunchGate -DurableConsumptionValidated $true",
        "$launch=[IntentArc.PreflightEnvelope.NativeProcessDispatcher]::Run([IntentArc.PreflightEnvelope.ProcessRole]::Controller,$info,(New-IntentArcPreflightControllerLaunchBindings $document),$gate,'stderr-read-failure')",
        `try{[void](Finalize-IntentArcPreflightControllerAttempt -RootGuard $root -Launch $launch -ControllerStartedValid $true -LaunchAttemptedAtUtc $launchAt);$receipt=[IO.File]::ReadAllText(${quote(join(evidenceParent, "attempt", "attempt-receipt.json"))})|ConvertFrom-Json;[ordered]@{valid=Test-IntentArcPreflightAttemptReceipt $receipt;category=$receipt.infrastructureCategory;settled=$receipt.processSettled;stderrBytes=$receipt.stderrBytes;stderrHash=$receipt.stderrSha256;stderrEof=$receipt.stderrEof;stderrOverflow=$receipt.stderrOverflow}|ConvertTo-Json -Compress}finally{$root.Dispose()}`,
      ].join("\n"));
      expect(result.valid).toBe(true);
      expect(result.category).toBe("settlement-invalid");
      expect(result.settled).toBe(false);
      expect(result.stderrBytes).toBeGreaterThan(0);
      expect(result.stderrBytes).toBeLessThanOrEqual(8192);
      expect(result.stderrHash).toBeNull();
      expect(result.stderrEof).toBe(false);
      expect(result.stderrOverflow).toBe(false);
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 800));
      await disposeFixture(fixture);
    }
  });

  it("owns and disposes a created adverse Git process before returning failure", async () => {
    const fixture = await createFixture();
    const gitPath = join(fixture.root, "git.exe");
    const source = "using System;using System.Threading;public static class FixtureGit{public static int Main(string[] args){Thread.Sleep(700);Console.Write(\"git-fixture\\n\");return 0;}}";
    try {
      await runPowerShell(`Add-Type -TypeDefinition ${quote(source)} -Language CSharp -OutputAssembly ${quote(gitPath)} -OutputType ConsoleApplication`);
      fixture.document.gitPath = gitPath;
      const result = await runBoundaryHarness([
        `$document=${quote(JSON.stringify(fixture.document))}|ConvertFrom-Json`,
        "$clock=[Diagnostics.Stopwatch]::StartNew();$threw=$false;try{[void](Invoke-IntentArcPreflightGitObservation -AuthorizationDocument $document -Observation 'head' -Fault 'supervisor-identity')}catch{$threw=$true};$clock.Stop()",
        "[ordered]@{threw=$threw;elapsedMs=$clock.ElapsedMilliseconds}|ConvertTo-Json -Compress",
      ].join("\n"));
      expect(result.threw).toBe(true);
      expect(result.elapsedMs).toBeGreaterThanOrEqual(600);
    } finally { await disposeFixture(fixture); }
  });

  it("rejects coherent drift from separately pinned controller and Git bindings", async () => {
    const fixture = await createFixture();
    try {
      fixture.document.outerPowerShellPath = powerShell;
      fixture.document.gitPath = "C:\\Program Files\\Git\\cmd\\git.exe";
      fixture.document.controllerPath = join(fixture.root, "scripts", "desktop-release-preflight-out-preservation.ps1");
      const result = await runBoundaryHarness([
        `$document=${quote(JSON.stringify(fixture.document))}|ConvertFrom-Json`,
        "$controllerBindings=New-IntentArcPreflightControllerLaunchBindings -AuthorizationDocument $document;$gitBindings=New-IntentArcPreflightGitObservationBindings -AuthorizationDocument $document",
        "$accepted=[Collections.Generic.List[string]]::new()",
        "$info=New-IntentArcPreflightControllerStartInfo -AuthorizationDocument $document;$otherRoot='C:\\fixture coherent root';$otherController=Join-Path (Join-Path $otherRoot 'scripts') 'desktop-release-preflight-out-preservation.ps1';$info.Arguments=$info.Arguments.Replace($document.controllerPath,$otherController);$info.WorkingDirectory=$otherRoot;try{[void][IntentArc.PreflightEnvelope.NativeProcessDispatcher]::Run([IntentArc.PreflightEnvelope.ProcessRole]::Controller,$info,$controllerBindings,(New-IntentArcPreflightControllerLaunchGate $true),'pre-creation-failure');[void]$accepted.Add('controller-root')}catch{}",
        "$info=New-IntentArcPreflightControllerStartInfo -AuthorizationDocument $document;$info.Arguments=$info.Arguments.Replace($document.pnpmPath,'C:\\fixture\\pnpm.exe');try{[void][IntentArc.PreflightEnvelope.NativeProcessDispatcher]::Run([IntentArc.PreflightEnvelope.ProcessRole]::Controller,$info,$controllerBindings,(New-IntentArcPreflightControllerLaunchGate $true),'pre-creation-failure');[void]$accepted.Add('pnpm')}catch{}",
        "$info=New-IntentArcPreflightGitObservationStartInfo -AuthorizationDocument $document -Observation 'head';$info.FileName='C:\\fixture\\git.exe';try{[void][IntentArc.PreflightEnvelope.NativeProcessDispatcher]::Run([IntentArc.PreflightEnvelope.ProcessRole]::GitObservation,$info,$gitBindings,$null,'pre-creation-failure');[void]$accepted.Add('git-executable')}catch{}",
        "$info=New-IntentArcPreflightGitObservationStartInfo -AuthorizationDocument $document -Observation 'head';$info.Arguments=$info.Arguments.Replace($document.canonicalPath,'C:\\fixture coherent root');$info.WorkingDirectory='C:\\fixture coherent root';try{[void][IntentArc.PreflightEnvelope.NativeProcessDispatcher]::Run([IntentArc.PreflightEnvelope.ProcessRole]::GitObservation,$info,$gitBindings,$null,'pre-creation-failure');[void]$accepted.Add('git-root')}catch{}",
        "[ordered]@{bindingsPresent=(($null-ne(Get-Command New-IntentArcPreflightControllerLaunchBindings -ErrorAction SilentlyContinue))-and($null-ne(Get-Command New-IntentArcPreflightGitObservationBindings -ErrorAction SilentlyContinue)));accepted=@($accepted)}|ConvertTo-Json -Compress",
      ].join("\n"));
      expect(result).toEqual({ bindingsPresent: true, accepted: [] });
    } finally { await disposeFixture(fixture); }
  });

  it.each([
    { label: "expected commit", field: "expectedCommit" as const, drift: "fedcba9876543210fedcba9876543210fedcba98" },
    { label: "expected pnpm SHA", field: "pnpmSha256" as const, drift: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" },
  ])("rejects well-formed $label drift from trusted bindings before launch", async ({ field, drift }) => {
    const fixture = await createFixture();
    try {
      fixture.document.outerPowerShellPath = powerShell;
      fixture.document.controllerPath = join(fixture.root, "scripts", "desktop-release-preflight-out-preservation.ps1");
      expect(fixture.document[field]).not.toBe(drift);
      const result = await runBoundaryHarness([
        `$document=${quote(JSON.stringify(fixture.document))}|ConvertFrom-Json`,
        `$original=[string]$document.${field}`,
        "$bindings=New-IntentArcPreflightControllerLaunchBindings -AuthorizationDocument $document",
        "$info=New-IntentArcPreflightControllerStartInfo -AuthorizationDocument $document",
        `$info.Arguments=$info.Arguments.Replace($original,${quote(drift)})`,
        "$launch=$null;$message=$null;try{$launch=[IntentArc.PreflightEnvelope.NativeProcessDispatcher]::Run([IntentArc.PreflightEnvelope.ProcessRole]::Controller,$info,$bindings,(New-IntentArcPreflightControllerLaunchGate $true),'pre-creation-failure')}catch{$message=$_.Exception.InnerException.Message}",
        "$created=$null;if($null-ne$launch){$created=$launch.processCreated};[ordered]@{accepted=($null-eq$message);message=$message;processCreated=$created}|ConvertTo-Json -Compress",
      ].join("\n"));
      expect(result).toEqual({ accepted: false, message: "process-bindings-invalid", processCreated: null });
    } finally { await disposeFixture(fixture); }
  });
});

const task5Timestamp = (second: number) => `2026-09-02T00:00:${String(second).padStart(2, "0")}.000Z`;
const task5Id06Timestamp = (second: number) => `2026-09-02T00:00:${String(second).padStart(2, "0")}.0000000Z`;
const task5Commit = "a".repeat(40);
const task5PnpmSha256 = "b".repeat(64);
const task5AuthorizationSha256 = "c".repeat(64);
const task5ConsumptionSha256 = "d".repeat(64);
const task5Paths = {
  source: "C:\\fixture repository\\out",
  destination: "C:\\fixture repository\\.superpowers\\preflight-out-preservation\\phase1-preflight-20260901-06\\out",
  profile: "C:\\fixture repository\\.superpowers\\preflight-out-preservation\\phase1-preflight-20260901-06\\profile",
  localAppData: "C:\\fixture repository\\.superpowers\\preflight-out-preservation\\phase1-preflight-20260901-06\\localappdata",
  pnpm: "C:\\fixture tools\\pnpm.exe",
};

const task5ControllerStarted = () => ({
  schema: "intentarc.preflight-execution-controller-started/v1", attemptId: "phase1-preflight-envelope-20260902-01",
  controllerRunId: "phase1-preflight-20260901-06", authorizationSha256: task5AuthorizationSha256,
  consumedSha256: task5ConsumptionSha256, controllerProcessId: 1,
  controllerStartTimeUtc: task5Timestamp(0), recordedAtUtc: task5Timestamp(1),
});

const task5AttemptReceipt = () => ({
  schema: "intentarc.preflight-execution-attempt-receipt/v1", attemptId: "phase1-preflight-envelope-20260902-01",
  controllerRunId: "phase1-preflight-20260901-06", launchAttemptedAtUtc: task5Timestamp(0),
  controllerStartedAtUtc: task5Timestamp(1), controllerProcessId: 1, controllerStartTimeUtc: task5Timestamp(1),
  captureCompletedAtUtc: task5Timestamp(2), controllerExitedAtUtc: task5Timestamp(2), controllerExitCode: 0,
  stdoutBytes: 2, stdoutSha256: sha256("{}"), stderrBytes: 0, stderrSha256: sha256(Buffer.alloc(0)),
  stdoutOverflow: false, stderrOverflow: false, stdoutEof: true, stderrEof: true, processSettled: true,
  infrastructureCategory: "none", recordedAtUtc: task5Timestamp(3),
});

const task5Result = () => ({
  schema: "intentarc.preflight-out-preservation-result/v2", status: "PASS", category: "none",
  cleanupCategory: "none", phase: "complete", childStarted: true, childExitCode: 0, outRestored: true,
});

const task5Receipt = () => ({
  schemaVersion: 2, runId: "phase1-preflight-20260901-06", status: "passed", failureCategory: null,
  checks: { "focused-tests": "passed", "server-typecheck": "passed", "web-typecheck": "passed", "adapter-strict": "passed" },
  git: { statusScope: "tracked-only", diffCheckPassed: true, productDiffClean: true, statusClean: true, statusEntryCount: 0 },
  source: { before: "1".repeat(64), after: "1".repeat(64), unchanged: true },
  packageJson: { before: "2".repeat(64), after: "2".repeat(64), unchanged: true },
  vendor: { before: "3".repeat(64), after: "3".repeat(64), unchanged: true },
  out: { absentBefore: true, absentAfter: true },
});

const task5State = (phase = "complete", childOverrides: Record<string, unknown> = {}) => {
  const entered = { prepared: 0, preserved: 1, "child-started": 2, "child-settled": 3, restored: 4, complete: 5 } as const;
  const phaseIndex = entered[phase as keyof typeof entered];
  const child = phaseIndex < 2 ? {
    jobName: "IntentArc.Preflight.phase1-preflight-20260901-06", rootProcessId: null, rootStartTimeUtc: null,
    assignmentStatus: "not-attempted", settlementStatus: "not-started", terminationReason: "not-started", exitCode: null,
    stdoutBytes: 0, stderrBytes: 0, outputOverflow: false, timedOut: false, canceled: false, infrastructureFailure: false,
  } : phaseIndex === 2 ? {
    jobName: "IntentArc.Preflight.phase1-preflight-20260901-06", rootProcessId: null, rootStartTimeUtc: null,
    assignmentStatus: "attempted", settlementStatus: "unsettled", terminationReason: "unknown", exitCode: null,
    stdoutBytes: 0, stderrBytes: 0, outputOverflow: false, timedOut: false, canceled: false, infrastructureFailure: false,
  } : {
    jobName: "IntentArc.Preflight.phase1-preflight-20260901-06", rootProcessId: 1, rootStartTimeUtc: task5Id06Timestamp(2),
    assignmentStatus: "assigned", settlementStatus: "settled", terminationReason: "normal-exit", exitCode: 0,
    stdoutBytes: 0, stderrBytes: 0, outputOverflow: false, timedOut: false, canceled: false, infrastructureFailure: false,
  };
  return {
    schema: "intentarc.preflight-out-preservation-state/v2", sourcePath: task5Paths.source,
    destinationPath: task5Paths.destination, runId: "phase1-preflight-20260901-06", expectedCommit: task5Commit,
    directory: { canonicalPath: task5Paths.source, attributes: 16, creationTimeUtc: task5Id06Timestamp(0), lastWriteTimeUtc: task5Id06Timestamp(0), stableIdentity: "00000001:0000000000000001" },
    ownedRoots: {
      profile: { canonicalPath: task5Paths.profile, attributes: 16, stableIdentity: "00000002:0000000000000002" },
      localAppData: { canonicalPath: task5Paths.localAppData, attributes: 16, stableIdentity: "00000003:0000000000000003" },
    },
    pnpm: { path: task5Paths.pnpm, sha256: task5PnpmSha256 }, child: { ...child, ...childOverrides },
    recovery: { mode: "none", sourcePhase: null, settlementProvenAt: null },
    cleanup: phase === "complete"
      ? { localAppDataStatus: "removed", profileStatus: "removed", runRootStatus: "removed", category: "none" }
      : { localAppDataStatus: "pending", profileStatus: "pending", runRootStatus: "pending", category: "none" },
    timestamps: {
      preparedAt: phaseIndex >= 0 ? task5Id06Timestamp(0) : null, preservedAt: phaseIndex >= 1 ? task5Id06Timestamp(1) : null,
      childStartedAt: phaseIndex >= 2 ? task5Id06Timestamp(2) : null, childSettledAt: phaseIndex >= 3 ? task5Id06Timestamp(3) : null,
      restoredAt: phaseIndex >= 4 ? task5Id06Timestamp(4) : null, completedAt: phaseIndex >= 5 ? task5Id06Timestamp(5) : null,
    },
    phase,
  };
};

const task5Audit = () => ({
  schema: "intentarc.preflight-execution-audit/v1", status: "AUDITED-PASS", category: "none",
  attemptId: "phase1-preflight-envelope-20260902-01", controllerRunId: "phase1-preflight-20260901-06",
  expectedCommit: task5Commit, attemptConsumed: true, controllerStarted: true, controllerExitCode: 0,
  resultSha256: "4".repeat(64), stateSha256: "5".repeat(64), receiptSha256: "6".repeat(64),
  outRestored: true, cleanupComplete: true, gitClean: true, bindingsValid: true,
});

const task5PowerShellJson = (value: unknown) => {
  const encoded = Buffer.from(JSON.stringify(value), "utf8").toString("base64");
  return `([Text.UTF8Encoding]::new($false,$true).GetString([Convert]::FromBase64String('${encoded}'))|ConvertFrom-Json -ErrorAction Stop)`;
};

const runTask5ValidationMatrix = async (documents: unknown[], invocation: string, reviewedScriptPath = scriptPath) => JSON.parse(await runPowerShellScript([
  `. ${quote(reviewedScriptPath)}`,
  `$documents=${task5PowerShellJson(documents)}`,
  "$answers=[Collections.Generic.List[bool]]::new()",
  `foreach($document in @($documents)){try{[void]$answers.Add([bool](${invocation}))}catch{[void]$answers.Add($false)}}`,
  "@($answers)|ConvertTo-Json -Compress",
].join("\n"))) as boolean[];

const task5StateInvocation = "Test-IntentArcId06StateV2 -Document $document " +
  `-ExpectedCommit '${task5Commit}' -PnpmPath '${task5Paths.pnpm}' -PnpmSha256 '${task5PnpmSha256}' ` +
  `-SourcePath '${task5Paths.source}' -DestinationPath '${task5Paths.destination}' ` +
  `-ProfilePath '${task5Paths.profile}' -LocalAppDataPath '${task5Paths.localAppData}'`;

describe.sequential("desktop release preflight once Task 5 closed JSON and ID06 validators", () => {
  it("closed JSON reader uses one same-handle read, exact byte hashes, strict UTF-8, duplicate rejection, and the closed size table", async () => {
    const fixture = await createFixture();
    const valid = Buffer.from(JSON.stringify({
      schema: "intentarc.preflight-execution-consumed/v1", attemptId: "phase1-preflight-envelope-20260902-01",
      authorizationSha256: task5AuthorizationSha256, consumedAtUtc: task5Timestamp(0), controllerLaunchStatus: "attempted",
    }), "utf8");
    const receiptText = JSON.stringify(task5Receipt());
    const identityPrefix = `"source":{"before":"${"1".repeat(64)}",`;
    const nestedDuplicate = Buffer.from(receiptText.replace(identityPrefix, `"source":{"before":"${"1".repeat(64)}","before":"${"1".repeat(64)}",`), "utf8");
    const paddedReceipt = Buffer.concat([Buffer.from(JSON.stringify(task5Receipt()), "utf8"), Buffer.alloc(262144 - Buffer.byteLength(JSON.stringify(task5Receipt())), 0x20)]);
    const cases = [
      { schema: "consumption", maximum: 16384, bytes: valid.toString("base64") },
      { schema: "consumption", maximum: 16384, bytes: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), valid]).toString("base64") },
      { schema: "consumption", maximum: 16384, bytes: Buffer.from([0xc3, 0x28]).toString("base64") },
      { schema: "id06Receipt", maximum: 262144, bytes: nestedDuplicate.toString("base64") },
      { schema: "consumption", maximum: 16384, bytes: Buffer.concat([valid, Buffer.from(" {}")]).toString("base64") },
      { schema: "id06Receipt", maximum: 262144, bytes: paddedReceipt.toString("base64") },
      { schema: "id06Receipt", maximum: 262144, bytes: Buffer.concat([paddedReceipt, Buffer.from(" ")]).toString("base64") },
      { schema: "unknown", maximum: 1, bytes: valid.toString("base64") },
    ];
    try {
      const result = JSON.parse(await runPowerShellScript([
        `. ${quote(scriptPath)}`, `$cases=${task5PowerShellJson(cases)}`, "$answers=@();Initialize-IntentArcPreflightExecutionNative",
        `$root=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::CreateExclusiveRoot(${quote(fixture.root)},'reader-evidence')`, "$index=0", "try{",
        "foreach($case in @($cases)){$guard=$null;try{$guard=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::WriteAtomicNew($root,('case-'+$index+'.json'),[Convert]::FromBase64String([string]$case.bytes));$read=Read-IntentArcClosedJsonDocument -Guard $guard -MaximumBytes ([int]$case.maximum) -Schema ([string]$case.schema);$answers+=,[ordered]@{ok=$true;length=$read.bytes.Length;sha256=$read.sha256}}catch{$answers+=,[ordered]@{ok=$false;category=$_.Exception.Message}}finally{if($null-ne$guard){$guard.Dispose()};$index++}}",
        "}finally{$root.Dispose()}", "@($answers)|ConvertTo-Json -Compress -Depth 4",
      ].join("\n"))) as Array<Record<string, unknown>>;
      expect(result[0]).toEqual({ ok: true, length: valid.length, sha256: sha256(valid) });
      expect(result.slice(1).map((entry) => entry.ok)).toEqual([false, false, false, false, true, false, false]);
      expect(result[5]).toMatchObject({ length: 262144, sha256: sha256(paddedReceipt) });
    } finally { await disposeFixture(fixture); }
  });

  it("consumption schema and controller-started schema reject key, type, binding, enum, integer, and timestamp drift", async () => {
    const consumption = {
      schema: "intentarc.preflight-execution-consumed/v1", attemptId: "phase1-preflight-envelope-20260902-01",
      authorizationSha256: task5AuthorizationSha256, consumedAtUtc: task5Timestamp(0), controllerLaunchStatus: "attempted",
    };
    const consumptionCases = [consumption, { ...consumption, extra: true }, { ...consumption, attemptId: 1 },
      { ...consumption, authorizationSha256: "A".repeat(64) }, { ...consumption, consumedAtUtc: "not-time" },
      { ...consumption, controllerLaunchStatus: "not-attempted" }];
    expect(await runTask5ValidationMatrix(consumptionCases,
      `Test-IntentArcPreflightConsumption -Document $document -AuthorizationSha256 '${task5AuthorizationSha256}'`))
      .toEqual([true, false, false, false, false, false]);

    const started = {
      schema: "intentarc.preflight-execution-controller-started/v1", attemptId: "phase1-preflight-envelope-20260902-01",
      controllerRunId: "phase1-preflight-20260901-06", authorizationSha256: task5AuthorizationSha256,
      consumedSha256: task5ConsumptionSha256, controllerProcessId: 1, controllerStartTimeUtc: task5Timestamp(0), recordedAtUtc: task5Timestamp(1),
    };
    const startedCases = [started, { ...started, consumedSha256: "e".repeat(64) }, { ...started, controllerProcessId: 0 },
      { ...started, controllerProcessId: 1.5 }, { ...started, controllerProcessId: 2147483648 },
      { ...started, controllerStartTimeUtc: task5Timestamp(2) }, { ...started, controllerRunId: "drift" }];
    expect(await runTask5ValidationMatrix(startedCases,
      `Test-IntentArcPreflightControllerStarted -Document $document -AuthorizationSha256 '${task5AuthorizationSha256}' -ConsumedSha256 '${task5ConsumptionSha256}'`))
      .toEqual([true, false, false, false, false, false, false]);
  });

  it("attempt receipt schema rejects coercion, unsafe counters, incomplete capture, timestamp reversal, and category disagreement", async () => {
    const receipt = task5AttemptReceipt();
    const cases = [receipt, { ...receipt, controllerProcessId: "1" }, { ...receipt, stdoutBytes: 1.5 },
      { ...receipt, stderrBytes: 9007199254740992 }, { ...receipt, captureCompletedAtUtc: task5Timestamp(0) },
      { ...receipt, stdoutSha256: null }, { ...receipt, stdoutBytes: 1048577 },
      { ...receipt, infrastructureCategory: "capture-overflow" }, { ...receipt, extra: false }];
    expect(await runTask5ValidationMatrix(cases, "Test-IntentArcPreflightAttemptReceipt -Document $document"))
      .toEqual([true, false, false, false, false, false, false, false, false]);
  });

  it("ID06 v2 validator closes result and receipt enums, types, nested keys, and candidate-success agreement", async () => {
    const result = task5Result();
    const recovered = { ...result, status: "RECOVERED", category: "recovery-restored", childStarted: false, childExitCode: null };
    const refused = { ...result, status: "REFUSED", category: "repository-invalid", phase: "validated", childStarted: false, childExitCode: null, outRestored: false };
    const failed = { ...result, status: "FAIL", category: "preflight-failed", childExitCode: -2147483648 };
    const resultCases = [result, recovered, refused, failed, { ...result, status: "RECOVERED" }, { ...result, category: "preflight-failed" },
      { ...result, childExitCode: "0" }, { ...result, childStarted: false }, { ...result, phase: "restored" }, { ...result, extra: true },
      { ...failed, category: "preflight-timeout", childExitCode: 7 },
      { ...failed, category: "preflight-start-failed", childStarted: true },
      { ...failed, category: "receipt-invalid", childExitCode: null },
      { ...failed, category: "residue-invalid", phase: "restored", cleanupCategory: "residue-invalid" },
      { ...failed, category: "out-restoration-failed", outRestored: true },
    ];
    expect(await runTask5ValidationMatrix(resultCases, "Test-IntentArcId06ResultV2 -Document $document"))
      .toEqual([true, true, true, true, false, false, false, false, false, false, false, false, false, false, false]);

    const receipt = task5Receipt();
    const failedReceipt = { ...receipt, status: "failed", failureCategory: "focused-tests", checks: { ...receipt.checks, "focused-tests": "failed" } };
    const receiptCases = [receipt, { ...receipt, status: "running" }, failedReceipt, { ...receipt, schemaVersion: 2.5 },
      { ...receipt, checks: { ...receipt.checks, "focused-tests": "unknown" } },
      { ...receipt, git: { ...receipt.git, statusEntryCount: 0.5 } },
      { ...receipt, source: { ...receipt.source, after: "9".repeat(64) } }, { ...receipt, extra: true }];
    expect(await runTask5ValidationMatrix(receiptCases, "Test-IntentArcId06Receipt -Document $document"))
      .toEqual([true, true, true, false, false, false, false, false]);

    const state = task5State();
    const agreementCases = [
      { result, state, receipt },
      { result: { ...result, childExitCode: 1 }, state, receipt },
      { result, state: { ...state, expectedCommit: "e".repeat(40) }, receipt },
      { result, state: task5State("complete", { exitCode: 1 }), receipt },
      { result, state, receipt: { ...receipt, status: "failed", failureCategory: "focused-tests" } },
    ];
    const invocation = `Test-IntentArcId06CandidateSuccess -Result $document.result -State $document.state -Receipt $document.receipt -ExpectedCommit '${task5Commit}' -PnpmPath '${task5Paths.pnpm}' -PnpmSha256 '${task5PnpmSha256}' -SourcePath '${task5Paths.source}' -DestinationPath '${task5Paths.destination}' -ProfilePath '${task5Paths.profile}' -LocalAppDataPath '${task5Paths.localAppData}'`;
    expect(await runTask5ValidationMatrix(agreementCases, invocation)).toEqual([true, false, false, false, false]);
  });

  it("consistency matrix accepts every approved ID06 child row and rejects contradictory identity, status, exit, counter, and flags", async () => {
    const settled = (overrides: Record<string, unknown>) => task5State("child-settled", overrides);
    const validRows = [
      task5State("prepared"), task5State("preserved"), task5State("child-started"),
      settled({}), settled({ exitCode: -2147483648 }), settled({ rootProcessId: 2147483647 }),
      settled({ terminationReason: "output-overflow", exitCode: null, stdoutBytes: 1048577, outputOverflow: true }),
      settled({ terminationReason: "timeout", exitCode: null, timedOut: true }),
      settled({ rootProcessId: null, rootStartTimeUtc: null, assignmentStatus: "attempted", terminationReason: "canceled", exitCode: null, canceled: true }),
      settled({ terminationReason: "canceled", exitCode: null, canceled: true }),
      settled({ rootProcessId: null, rootStartTimeUtc: null, assignmentStatus: "attempted", terminationReason: "infrastructure-failure", exitCode: null, infrastructureFailure: true }),
      settled({ terminationReason: "infrastructure-failure", exitCode: -1, infrastructureFailure: true }),
      settled({ rootProcessId: null, rootStartTimeUtc: null, assignmentStatus: "attempted", settlementStatus: "unsettled", terminationReason: "settlement-failed", exitCode: null, infrastructureFailure: true }),
      settled({ assignmentStatus: "unknown", settlementStatus: "unsettled", terminationReason: "settlement-failed", exitCode: 7, stdoutBytes: 1048577, infrastructureFailure: true, outputOverflow: true }),
    ];
    expect(await runTask5ValidationMatrix(validRows, task5StateInvocation)).toEqual(validRows.map(() => true));
    const invalidRows = [
      settled({ rootStartTimeUtc: null }), settled({ assignmentStatus: "attempted" }), settled({ settlementStatus: "unsettled" }),
      settled({ terminationReason: "normal-exit", exitCode: null }), settled({ terminationReason: "output-overflow", exitCode: null, outputOverflow: true }),
      settled({ terminationReason: "timeout", exitCode: null, timedOut: true, canceled: true }),
      settled({ terminationReason: "infrastructure-failure", infrastructureFailure: false }),
      settled({ terminationReason: "settlement-failed", settlementStatus: "unsettled", infrastructureFailure: false }),
      settled({ stdoutBytes: -1 }), settled({ stderrBytes: 9007199254740992 }), settled({ rootProcessId: 0 }),
      { ...task5State(), timestamps: { ...task5State().timestamps, completedAt: task5Id06Timestamp(3) } },
      { ...task5State(), recovery: { mode: "restore-only", sourcePhase: "child-settled", settlementProvenAt: task5Id06Timestamp(2) } },
      { ...task5State(), cleanup: { localAppDataStatus: "removed", profileStatus: "retained", runRootStatus: "removed", category: "residue-invalid" } },
    ];
    expect(await runTask5ValidationMatrix(invalidRows, task5StateInvocation)).toEqual(invalidRows.map(() => false));
  });

  it("ID06 state validator binds exact commit, pnpm, paths, stable identities, timestamps, recovery history, and cleanup terminality", async () => {
    const state = task5State();
    const recovery = task5State("complete");
    recovery.recovery = { mode: "restore-only", sourcePhase: "child-settled", settlementProvenAt: task5Id06Timestamp(3) };
    const recoveredStates = (["prepared", "preserved", "child-started", "child-settled"] as const).map((sourcePhase) => {
      const source = task5State(sourcePhase);
      return {
        ...source, phase: "complete", recovery: { mode: "restore-only", sourcePhase, settlementProvenAt: task5Id06Timestamp(3) },
        cleanup: { localAppDataStatus: "removed", profileStatus: "removed", runRootStatus: "removed", category: "none" },
        timestamps: { ...source.timestamps, restoredAt: task5Id06Timestamp(4), completedAt: task5Id06Timestamp(5) },
      };
    });
    const retainedCleanup = { ...state, cleanup: { localAppDataStatus: "retained", profileStatus: "removed", runRootStatus: "retained", category: "residue-invalid" } };
    const cases = [state, recovery, ...recoveredStates, retainedCleanup, { ...state, expectedCommit: "e".repeat(40) },
      { ...state, pnpm: { ...state.pnpm, sha256: "f".repeat(64) } }, { ...state, sourcePath: task5Paths.destination },
      { ...state, directory: { ...state.directory, attributes: 1040 } },
      { ...state, ownedRoots: { ...state.ownedRoots, profile: { ...state.ownedRoots.profile, stableIdentity: "bad" } } },
      { ...state, timestamps: { ...state.timestamps, restoredAt: task5Id06Timestamp(5), completedAt: task5Id06Timestamp(4) } },
      { ...state, cleanup: { ...state.cleanup, category: "residue-invalid" } }, { ...state, extra: true }];
    expect(await runTask5ValidationMatrix(cases, task5StateInvocation))
      .toEqual([true, true, true, true, true, true, true, false, false, false, false, false, false, false, false]);
  });

  it("closed schemas reject every omitted top-level key and non-object root without permissive fallthrough", async () => {
    const omitEach = (value: Record<string, unknown>) => Object.keys(value).map((key) => Object.fromEntries(Object.entries(value).filter(([name]) => name !== key)));
    const validators: Array<[Record<string, unknown>, string]> = [
      [{ schema: "intentarc.preflight-execution-consumed/v1", attemptId: "phase1-preflight-envelope-20260902-01", authorizationSha256: task5AuthorizationSha256, consumedAtUtc: task5Timestamp(0), controllerLaunchStatus: "attempted" }, `Test-IntentArcPreflightConsumption -Document $document -AuthorizationSha256 '${task5AuthorizationSha256}'`],
      [task5AttemptReceipt(), "Test-IntentArcPreflightAttemptReceipt -Document $document"],
      [task5Result(), "Test-IntentArcId06ResultV2 -Document $document"],
      [task5State(), task5StateInvocation],
      [task5Receipt(), "Test-IntentArcId06Receipt -Document $document"],
      [task5Audit(), "Test-IntentArcPreflightAuditResult -Document $document"],
    ];
    for (const [document, invocation] of validators) {
      const cases = [...omitEach(document), [], null, "coerced"];
      expect(await runTask5ValidationMatrix(cases, invocation)).toEqual(cases.map(() => false));
    }
  });

  it("audit result validator enforces canonical 16-key order and closed positive and terminal combinations", async () => {
    const pass = task5Audit();
    const refusal = { ...expectedRefusal };
    const reordered = Object.fromEntries(Object.entries(pass).reverse());
    const cases = [pass, refusal, reordered, { ...pass, status: "TERMINAL-NOT-PASS" },
      { ...pass, category: "repository-invalid" }, { ...pass, controllerExitCode: null },
      { ...refusal, expectedCommit: task5Commit }, { ...refusal, attemptConsumed: true }, { ...refusal, extra: true }];
    expect(await runTask5ValidationMatrix(cases, "Test-IntentArcPreflightAuditResult -Document $document"))
      .toEqual([true, true, false, false, false, false, false, false, false]);
  });

  it("kills omitted-key, permissive parser, numeric coercion, timestamp-order, recovery-history, and success-disagreement mutants", async () => {
    const source = await readFile(scriptPath, "utf8");
    const fixture = await createFixture();
    const insertOverride = (body: string) => source.replace(
      "\nif (-not $script:IntentArcPreflightEnvelopeWasDotSourced) {",
      `\n${body}\nif (-not $script:IntentArcPreflightEnvelopeWasDotSourced) {`,
    );
    const cases: Array<{ name: string; mutant: string; documents: unknown[]; invocation: string }> = [
      {
        name: "omitted-key", mutant: insertOverride("function Test-IntentArcPreflightExecutionExactPropertyNames { param($Value,[string[]]$Expected) return $true }"),
        documents: [{ ...task5Result(), extra: true }], invocation: "Test-IntentArcId06ResultV2 -Document $document",
      },
      {
        name: "numeric-coercion", mutant: insertOverride("function Test-IntentArcPreflightClosedInteger { param($Value,[long]$Minimum,[long]$Maximum) try { return [long]$Value -ge $Minimum -and [long]$Value -le $Maximum } catch { return $false } }"),
        documents: [task5State("child-settled", { rootProcessId: "1" })], invocation: task5StateInvocation,
      },
      {
        name: "timestamp-order", mutant: source.replace("if ($parsed -lt $last) { return $false }; $last=$parsed", "if ($false) { return $false }; $last=$parsed"),
        documents: [{ ...task5State(), timestamps: { ...task5State().timestamps, restoredAt: task5Id06Timestamp(5), completedAt: task5Id06Timestamp(4) } }], invocation: task5StateInvocation,
      },
      {
        name: "recovery-history", mutant: source.replace("if ($Recovery.mode -ceq 'restore-only') { $effectivePhase = $Recovery.sourcePhase }", "if ($Recovery.mode -ceq 'restore-only') { $effectivePhase = 'child-settled' }"),
        documents: [{
          ...task5State("prepared"), phase: "complete", child: task5State().child,
          recovery: { mode: "restore-only", sourcePhase: "prepared", settlementProvenAt: task5Id06Timestamp(3) },
          cleanup: task5State().cleanup,
          timestamps: { ...task5State("prepared").timestamps, restoredAt: task5Id06Timestamp(4), completedAt: task5Id06Timestamp(5) },
        }], invocation: task5StateInvocation,
      },
      {
        name: "candidate-agreement", mutant: source.replace("$State.child.terminationReason-ceq'normal-exit'-and$State.child.exitCode-eq0-and", "$State.child.terminationReason-ceq'normal-exit'-and$true-and"),
        documents: [{ result: task5Result(), state: task5State("complete", { exitCode: 1 }), receipt: task5Receipt() }],
        invocation: `Test-IntentArcId06CandidateSuccess -Result $document.result -State $document.state -Receipt $document.receipt -ExpectedCommit '${task5Commit}' -PnpmPath '${task5Paths.pnpm}' -PnpmSha256 '${task5PnpmSha256}' -SourcePath '${task5Paths.source}' -DestinationPath '${task5Paths.destination}' -ProfilePath '${task5Paths.profile}' -LocalAppDataPath '${task5Paths.localAppData}'`,
      },
    ];
    try {
      for (const item of cases) {
        expect(item.mutant, `${item.name} must alter source`).not.toBe(source);
        const mutantPath = join(fixture.root, `task5-${item.name}.ps1`);
        await writeFile(mutantPath, item.mutant, "utf8");
        expect(await runTask5ValidationMatrix(item.documents, item.invocation, mutantPath), `${item.name} must be observable`).toBe(true);
      }

      const duplicateReceipt = JSON.stringify(task5Receipt()).replace(
        `"source":{"before":"${"1".repeat(64)}",`,
        `"source":{"before":"${"1".repeat(64)}","before":"${"1".repeat(64)}",`,
      );
      const parserMutant = insertOverride("function Assert-IntentArcPreflightExecutionJsonHasNoDuplicateKeys { param([string]$Text) }");
      const parserMutantPath = join(fixture.root, "task5-permissive-parser.ps1");
      await writeFile(parserMutantPath, parserMutant, "utf8");
      const outcome = JSON.parse(await runPowerShellScript([
        `. ${quote(parserMutantPath)}`, `$bytes=[Text.UTF8Encoding]::new($false,$true).GetBytes(${quote(duplicateReceipt)})`, "Initialize-IntentArcPreflightExecutionNative",
        `$root=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::CreateExclusiveRoot(${quote(fixture.root)},'parser-mutant-evidence');$guard=$null`,
        "try{$guard=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::WriteAtomicNew($root,'receipt.json',$bytes);$accepted=try{[void](Read-IntentArcClosedJsonDocument -Guard $guard -MaximumBytes 262144 -Schema 'id06Receipt');$true}catch{$false};$accepted|ConvertTo-Json -Compress}finally{if($null-ne$guard){$guard.Dispose()};$root.Dispose()}",
      ].join("\n"))) as boolean;
      expect(outcome, "ConvertFrom-Json-only duplicate parsing must be observable").toBe(true);
    } finally { await disposeFixture(fixture); }
  }, 120_000);
});

type Task6Evidence = {
  attemptRootDisposition: "absent" | "present" | "indeterminate";
  authorizationCopyValid: boolean;
  consumptionDisposition: "absent" | "valid" | "invalid";
  controllerStartedDisposition: "absent" | "valid" | "invalid";
  attemptReceiptDisposition: "absent" | "valid" | "invalid";
  journalBindingsValid: boolean;
  startedReceiptIdentityValid: boolean;
  supervisorIdentityInvalidShape: boolean;
  receiptInfrastructureCategory: null | "none" | "launch-failed" | "consumption-journal-invalid" | "capture-overflow" | "capture-invalid" | "settlement-invalid";
  controllerExitCode: number | null;
  controllerStdoutDisposition: "absent" | "valid" | "invalid";
  resultDisposition: "absent" | "candidate" | "not-candidate" | "invalid";
  resultSha256: string | null;
  stateDisposition: "absent" | "valid" | "invalid";
  stateSha256: string | null;
  id06ReceiptDisposition: "absent" | "valid" | "invalid";
  receiptSha256: string | null;
  jobDisposition: "absent" | "present" | "indeterminate";
  controllerProcessDisposition: "absent" | "reused" | "present" | "indeterminate" | "not-applicable";
  childProcessDisposition: "absent" | "reused" | "present" | "indeterminate" | "not-applicable";
  settlementValid: boolean;
  sourceFinalPathValid: boolean;
  sourceStableIdentityValid: boolean;
  sourceParentIdentityValid: boolean;
  destinationDisposition: "absent" | "present" | "indeterminate";
  cleanupResidueDispositions: Array<"absent" | "present" | "indeterminate">;
  bindingsDisposition: "valid" | "invalid" | "indeterminate";
  infrastructureValid: boolean;
  storedAuditDisposition: "absent" | "present" | "invalid" | "indeterminate";
  storedAuditDocument: Record<string, unknown> | null;
  storedAuditBytesBase64: string | null;
};

const task6SuccessEvidence = (): Task6Evidence => ({
  attemptRootDisposition: "present", authorizationCopyValid: true, consumptionDisposition: "valid",
  controllerStartedDisposition: "valid", attemptReceiptDisposition: "valid", journalBindingsValid: true,
  startedReceiptIdentityValid: true, supervisorIdentityInvalidShape: false, receiptInfrastructureCategory: "none",
  controllerExitCode: 0, controllerStdoutDisposition: "valid", resultDisposition: "candidate", resultSha256: "4".repeat(64),
  stateDisposition: "valid", stateSha256: "5".repeat(64), id06ReceiptDisposition: "valid", receiptSha256: "6".repeat(64),
  jobDisposition: "absent", controllerProcessDisposition: "reused", childProcessDisposition: "reused", settlementValid: true,
  sourceFinalPathValid: true, sourceStableIdentityValid: true, sourceParentIdentityValid: true, destinationDisposition: "absent",
  cleanupResidueDispositions: ["absent", "absent", "absent"], bindingsDisposition: "valid", infrastructureValid: true,
  storedAuditDisposition: "absent", storedAuditDocument: null, storedAuditBytesBase64: null,
});

const task6Expected = (category: string) => {
  const base = { ...task5Audit(), status: "TERMINAL-NOT-PASS", category };
  if (category === "none") return task5Audit();
  if (category === "authorization-invalid") return { ...expectedRefusal };
  if (["attempt-not-consumed", "attempt-evidence-invalid", "audit-infrastructure-invalid"].includes(category)) {
    return { ...base, attemptConsumed: false, controllerStarted: false, controllerExitCode: null, resultSha256: null,
      stateSha256: null, receiptSha256: null, outRestored: false, cleanupComplete: false, gitClean: false, bindingsValid: false };
  }
  if (category === "controller-not-started") return { ...base, controllerStarted: false, controllerExitCode: null,
    resultSha256: null, stateSha256: null, receiptSha256: null, outRestored: false, cleanupComplete: false, gitClean: false, bindingsValid: false };
  if (category === "controller-outcome-uncertain") return { ...base, controllerStarted: false, controllerExitCode: null, resultSha256: null,
    stateSha256: null, receiptSha256: null, outRestored: false, cleanupComplete: false, gitClean: false, bindingsValid: false };
  if (category === "controller-capture-invalid") return { ...base, resultSha256: null, stateSha256: null,
    receiptSha256: null, outRestored: false, cleanupComplete: false, gitClean: false, bindingsValid: false };
  if (category === "controller-result-invalid") return { ...base, resultSha256: null, stateSha256: null,
    receiptSha256: null, outRestored: false, cleanupComplete: false, gitClean: false, bindingsValid: false };
  if (category === "controller-state-invalid") return { ...base, stateSha256: null, receiptSha256: null,
    outRestored: false, cleanupComplete: false, gitClean: false, bindingsValid: false };
  if (category === "controller-receipt-invalid") return { ...base, receiptSha256: null, outRestored: false,
    cleanupComplete: false, gitClean: false, bindingsValid: false };
  if (["child-settlement-invalid", "out-restoration-invalid"].includes(category)) return { ...base, outRestored: false,
    cleanupComplete: false, gitClean: false, bindingsValid: false };
  if (category === "cleanup-invalid") return { ...base, cleanupComplete: false, gitClean: false, bindingsValid: false };
  if (category === "repository-invalid") return { ...base, gitClean: false, bindingsValid: false };
  if (category === "binding-invalid") return { ...base, bindingsValid: false };
  throw new Error(`unhandled category ${category}`);
};

const runTask6Audit = async (fixture: Fixture, evidence: Task6Evidence, options: {
  host?: boolean;
  mode?: "Execute" | "AuditOnly"; git?: Partial<Record<"root" | "branch" | "head" | "status", { exitCode: number; stderrBytes: number; overflow: boolean; stdout: string }>>;
  scriptPath?: string; gitThrows?: "root" | "branch" | "head" | "status"; malformedOperations?: boolean; nullOperations?: boolean; malformedAuthorization?: boolean;
} = {}) => {
  fixture.document.expectedCommit = task5Commit;
  const bytes = Buffer.from(JSON.stringify(fixture.document)); await writeFile(fixture.paths.manifest, bytes); const expectedHash = sha256(bytes);
  const mode = options.mode ?? "AuditOnly";
  const defaultGit = {
    root: { exitCode: 0, stderrBytes: 0, overflow: false, stdout: `${fixture.root}\n` },
    branch: { exitCode: 0, stderrBytes: 0, overflow: false, stdout: "master\n" },
    head: { exitCode: 0, stderrBytes: 0, overflow: false, stdout: `${fixture.document.expectedCommit}\n` },
    status: { exitCode: 0, stderrBytes: 0, overflow: false, stdout: "" },
    ...options.git,
  };
  const body = [
    `. ${quote(options.scriptPath ?? scriptPath)}`, `$contract=${contractExpression(fixture)}`,
    `$invocation=[pscustomobject]@{mode=${quote(mode)};manifestPath=${quote(fixture.paths.manifest)};expectedSha256=${quote(expectedHash)};InvocationMetadata=[pscustomobject]@{HostImagePath=${quote(fixture.paths.host)};RawCommandLine=${quote(reviewedHostText(fixture, mode, expectedHash))};EnvelopePath=${quote(fixture.paths.envelope)}}}`,
    `$context=Read-IntentArcPreflightExecutionAuthorizationManifest -LiteralPath ${quote(fixture.paths.manifest)} -ExpectedSha256 ${quote(expectedHash)} -ActualInvocation $invocation -Contract $contract`,
    `$evidence=${task5PowerShellJson(evidence)};$git=${task5PowerShellJson(defaultGit)}`,
    "$state=[pscustomobject]@{reads=0;writes=0;controllerStarts=0;cleanupCalls=0;git=[Collections.Generic.List[string]]::new();written=$null}",
    `$gitThrows=${options.gitThrows ? quote(options.gitThrows) : "$null"}`,
    "$readHandler={param($document)$state.reads++;$evidence}.GetNewClosure();$gitHandler={param($document,$name)[void]$state.git.Add([string]$name);if($name-ceq$gitThrows){throw 'git-observation-fault'};$git.$name}.GetNewClosure();$writeHandler={param($document,[byte[]]$auditBytes)$state.writes++;$state.written=[Convert]::ToBase64String($auditBytes);[pscustomobject][ordered]@{written=$true}}.GetNewClosure()",
    "$handlers=[ordered]@{ReadAuditEvidence=$readHandler;ObserveGit=$gitHandler;WriteAuditResult=$writeHandler}",
    `$operations=${options.nullOperations ? "$null" : options.malformedOperations ? "([pscustomobject]@{})" : "New-IntentArcPreflightTerminalAuditOperations -Handlers $handlers"}`,
    `$auditContext=${options.malformedAuthorization ? "([pscustomobject]@{})" : "$context"}`,
    options.host ? "$result=Invoke-IntentArcPreflightEnvelopeHost -Invocation $invocation -Contract $contract -Operations ([pscustomobject]@{Execute=$null;Audit=$operations})" : `$result=${mode === "AuditOnly" ? "Invoke-IntentArcPreflightEnvelopeAuditOnly" : "Invoke-IntentArcPreflightTerminalAudit"} -AuthorizationContext $auditContext -Operations $operations`,
    "$resultDocument=([Text.UTF8Encoding]::new($false,$true).GetString((ConvertTo-IntentArcPreflightEnvelopeCanonicalBytes -Document $result))|ConvertFrom-Json -ErrorAction Stop);$answer=[ordered]@{result=$result;valid=(Test-IntentArcPreflightAuditResult -Document $resultDocument);reads=$state.reads;writes=$state.writes;controllerStarts=$state.controllerStarts;cleanupCalls=$state.cleanupCalls;git=@($state.git);written=$state.written}",
    "$context.Dispose();$answer|ConvertTo-Json -Compress -Depth 12",
  ].join("\n");
  return JSON.parse(await runPowerShellScript(body)) as { result: Record<string, unknown>; valid: boolean; reads: number; writes: number; controllerStarts: number; cleanupCalls: number; git: string[]; written: string | null };
};

describe.sequential("Task 7 source policy and public host", () => {
  it.each([[false, false], [true, false], [true, true]])("public host production wiring persists owned-root terminal audit after receipt (execute failure %s, unowned replay %s) and replay writes nothing", async (failAfterReceipt, unownedReplay) => {
    const fixture = await createFixture();
    try {
      for (const relative of ["out", ".superpowers/preflight-execution-envelope", ".superpowers/preflight-out-preservation", ".superpowers/preflight/desktop-release"]) await mkdir(join(fixture.root, relative), { recursive: true });
      const bytes = await readFile(fixture.paths.manifest); const hash = sha256(bytes);
      const result = JSON.parse(await runPowerShellScript([
        `. ${quote(scriptPath)}`, `$contract=${contractExpression(fixture)}`,
        `$invocation=[pscustomobject]@{mode='Execute';manifestPath=${quote(fixture.paths.manifest)};expectedSha256='${hash}';InvocationMetadata=[pscustomobject]@{HostImagePath=${quote(fixture.paths.host)};EnvelopePath=${quote(fixture.paths.envelope)};RawCommandLine=${quote(reviewedHostText(fixture,"Execute",hash))}}}`,
        `$context=Read-IntentArcPreflightExecutionAuthorizationManifest -LiteralPath $invocation.manifestPath -ExpectedSha256 '${hash}' -ActualInvocation $invocation -Contract $contract`,
        // Replace only external process effects; bind, guard, namespace, journal and auditor stay real.
        "function Invoke-IntentArcPreflightGitObservation {param($AuthorizationDocument,$Observation)$text=switch($Observation){root{$AuthorizationDocument.canonicalPath+\"`n\"};branch{\"master`n\"};head{$AuthorizationDocument.expectedCommit+\"`n\"};status{''}};[pscustomobject]@{exitCode=0;stderrBytes=0;stdoutText=$text}}",
        "$operations=New-IntentArcPreflightEnvelopeProductionOperations -AuthorizationContext $context",
        failAfterReceipt ? "$realFinalize=${function:Finalize-IntentArcPreflightControllerAttempt};function Finalize-IntentArcPreflightControllerAttempt {param($RootGuard,$Launch,$ControllerStartedValid,$LaunchAttemptedAtUtc)[void](& $realFinalize -RootGuard $RootGuard -Launch $Launch -ControllerStartedValid $ControllerStartedValid -LaunchAttemptedAtUtc $LaunchAttemptedAtUtc);throw 'fixture-post-receipt-failure'}" : "",
        "function Invoke-IntentArcPreflightControllerLaunch {param($StartInfo,$Bindings,$Gate)[pscustomobject][ordered]@{processCreated=$false;nonCreationProven=$true;supervisor=$null;supervisorIdentityValid=$false;drainsInitialized=$false;setupCategory='launch-failed'}}",
        "$Error.Clear();$counts=[pscustomobject]@{writes=0}",
        unownedReplay ? "try{[void](Invoke-IntentArcPreflightEnvelopeExecute -AuthorizationContext $context -Operations $operations.Execute)}catch{};$operations.Execute.DisposeBoundaryGuards();$operations=New-IntentArcPreflightEnvelopeProductionOperations -AuthorizationContext $context;function Write-IntentArcPreflightEnvelopeImmutableBytes {$counts.writes++;throw 'unexpected replay write'}" : "",
        "$result=Invoke-IntentArcPreflightEnvelopeHost -Invocation $invocation -Contract $contract -Operations $operations;$context.Dispose();[ordered]@{audit=$result;writes=$counts.writes;errors=@($Error|ForEach-Object{$_.Exception.Message})}|ConvertTo-Json -Compress -Depth 8",
      ].join("\n")));
      const attemptRoot = join(fixture.root, ".superpowers/preflight-execution-envelope/phase1-preflight-envelope-20260902-01");
      expect(result.audit.attemptConsumed, JSON.stringify(result)).toBe(true);
      const consumed = JSON.parse(await readFile(join(attemptRoot, "consumed.json"), "utf8"));
      const receipt = JSON.parse(await readFile(join(attemptRoot, "attempt-receipt.json"), "utf8"));
      expect(receipt.infrastructureCategory).toBe("launch-failed");
      expect(consumed.controllerLaunchStatus).toBe("attempted");
      expect(result.audit.attemptConsumed).toBe(true); expect(result.audit.controllerStarted).toBe(false);
      expect(result.audit.status).toBe("TERMINAL-NOT-PASS");
      const auditPath = join(attemptRoot, "audit-result.json");
      if (unownedReplay) {
        expect(result.writes).toBe(0);
        await expect(readFile(auditPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        const persisted = await readFile(auditPath, "utf8");
        expect(JSON.parse(persisted)).toEqual(result.audit);
      }
      if (failAfterReceipt) expect(result.errors.join(" ")).toContain("fixture-post-receipt-failure");
      const knownLeaves = ["authorization.json", "consumed.json", "attempt-receipt.json", ...(unownedReplay ? [] : ["audit-result.json"])];
      const beforeReplay = await Promise.all(knownLeaves.map((leaf) => readFile(join(attemptRoot, leaf), "utf8")));
      const replay = JSON.parse(await runPowerShellScript([
        `. ${quote(scriptPath)}`, `$contract=${contractExpression(fixture)}`,
        `$invocation=[pscustomobject]@{mode='Execute';manifestPath=${quote(fixture.paths.manifest)};expectedSha256='${hash}';InvocationMetadata=[pscustomobject]@{HostImagePath=${quote(fixture.paths.host)};EnvelopePath=${quote(fixture.paths.envelope)};RawCommandLine=${quote(reviewedHostText(fixture,"Execute",hash))}}}`,
        `$context=Read-IntentArcPreflightExecutionAuthorizationManifest -LiteralPath $invocation.manifestPath -ExpectedSha256 '${hash}' -ActualInvocation $invocation -Contract $contract`,
        "function Invoke-IntentArcPreflightGitObservation {param($AuthorizationDocument,$Observation)$text=switch($Observation){root{$AuthorizationDocument.canonicalPath+\"`n\"};branch{\"master`n\"};head{$AuthorizationDocument.expectedCommit+\"`n\"};status{''}};[pscustomobject]@{exitCode=0;stderrBytes=0;stdoutText=$text}}",
        "$counts=[pscustomobject]@{starts=0;writes=0};function Invoke-IntentArcPreflightControllerLaunch {$counts.starts++;throw 'unexpected replay launch'};function Write-IntentArcPreflightEnvelopeImmutableBytes {$counts.writes++;throw 'unexpected replay write'}",
        "$operations=New-IntentArcPreflightEnvelopeProductionOperations -AuthorizationContext $context;$result=Invoke-IntentArcPreflightEnvelopeHost -Invocation $invocation -Contract $contract -Operations $operations;$context.Dispose();[ordered]@{audit=$result;starts=$counts.starts;writes=$counts.writes}|ConvertTo-Json -Compress -Depth 8",
      ].join("\n")));
      expect(replay.starts).toBe(0); expect(replay.writes).toBe(0);
      expect(replay.audit.status).toBe("TERMINAL-NOT-PASS");
      expect(await Promise.all(knownLeaves.map((leaf) => readFile(join(attemptRoot, leaf), "utf8")))).toEqual(beforeReplay);
    } finally { await disposeFixture(fixture); }
  });
  it("public host Execute consumes before a single launch and returns the terminal audit", async () => {
    const fixture = await createFixture();
    try {
      const result = await runExecuteHarness(fixture, { host: true });
      expect(result.controllerStarts).toBe(1); expect(result.finalizations).toBe(1);
      expect(result.operations.indexOf("WriteConsumptionAttempted")).toBeLessThan(result.operations.indexOf("StartController"));
      expect(result.result).toEqual({ ...task5Audit(), expectedCommit: fixture.document.expectedCommit });
    } finally { await disposeFixture(fixture); }
  });
  it.each([true, false])("public host cannot promote or persist a failed Execute using stale positive evidence (stored %s)", async (hostStoredAudit) => {
    const fixture = await createFixture();
    try {
      const result = await runExecuteHarness(fixture, { host: true, hostStoredAudit, throwAt: hostStoredAudit ? "BindExecutionInputs" : "FinalizeControllerAttempt" });
      expect(result.controllerStarts).toBe(hostStoredAudit ? 0 : 1);
      expect(result.auditWrites).toBe(0);
      expect(result.result?.status).toBe("TERMINAL-NOT-PASS");
      expect(result.result?.category).toBe("audit-infrastructure-invalid");
    } finally { await disposeFixture(fixture); }
  });
  it.each([
    ["malformed", false], ["mismatch", false], ["malformed", true], ["mismatch", true],
  ] as const)("public host preserves invalid stored-audit precedence for %s (replay %s)", async (hostStoredAudit, replay) => {
    const fixture = await createFixture();
    try {
      if (replay) await mkdir(join(fixture.root, ".superpowers/preflight-execution-envelope/phase1-preflight-envelope-20260902-01"), { recursive: true });
      const result = await runExecuteHarness(fixture, { host: true, hostStoredAudit, throwAt: replay ? undefined : "FinalizeControllerAttempt" });
      expect(result.result?.status).toBe("TERMINAL-NOT-PASS");
      expect(result.result?.category).toBe("attempt-evidence-invalid");
      expect(result.controllerStarts).toBe(replay ? 0 : 1);
      expect(result.auditWrites).toBe(0);
    } finally { await disposeFixture(fixture); }
  });
  it("static self-test is inert and admits the reviewed source", async () => {
    const result = JSON.parse(await runPowerShellScript(`. ${quote(scriptPath)}\nfunction New-IntentArcPreflightEnvelopeProductionOperations { throw 'unexpected operation construction' }\nfunction New-IntentArcPreflightEnvelopeAttemptRoot { throw 'unexpected mutation' }\nInvoke-IntentArcPreflightEnvelopeStaticSelfTest | ConvertTo-Json -Compress -Depth 8`));
    expect(result).toEqual({ valid: true, categories: [] });
  });
  it("source policy rejects semantic consumption-state and host-gate changes", async () => {
    const source = await readFile(scriptPath, "utf8");
    for (const mutant of [source.replace("controllerLaunchStatus = 'attempted'", "controllerLaunchStatus = 'not-attempted'"), source.replace("if ($Invocation.mode -ceq 'Execute')", "if ($Invocation.mode -cne 'Execute')")]) {
      const result = JSON.parse(await runPowerShellScript(`. ${quote(scriptPath)}\nTest-IntentArcPreflightEnvelopeSourcePolicy -SourceText ${quote(mutant)} | ConvertTo-Json -Compress`));
      expect(result.valid).toBe(false);
    }
  });
  it("source policy rejects parse-valid return exit and constant control-flow mutants", async () => {
    const source = await readFile(scriptPath, "utf8");
    const start = source.indexOf("function Test-IntentArcPreflightEnvelopeContract {");
    const firstIf = source.indexOf("if (", start);
    expect(start).toBeGreaterThan(0); expect(firstIf).toBeGreaterThan(start);
    const firstDefinition = source.indexOf("function Throw-IntentArcPreflightExecutionAuthorizationInvalid {");
    const secondDefinition = source.indexOf("function Initialize-IntentArcPreflightExecutionNative {");
    const thirdDefinition = source.indexOf("function Get-IntentArcPreflightExecutionSha256 {");
    const mutants = [
      source.replace(/exit 1(\s*})\s*$/, "exit 0$1"),
      ...["return $true", "return $false", "return 1", "exit 0", "$true", "42", "if ($true) { return $true }", "switch (1) { 1 { return $true } }", "try { return $true } finally { $false }"].map((statement) => source.slice(0, firstIf) + statement + "; " + source.slice(firstIf)),
      source.replace("return $false", "return $true"),
      source.replace("exit 0 }", "exit 1 }"),
      source.slice(0, firstDefinition) + source.slice(secondDefinition, thirdDefinition) + source.slice(firstDefinition, secondDefinition) + source.slice(thirdDefinition),
      source.replace("# Reviewed AST call sites include receiver, arguments, order, cardinality and enclosing control flow.", "#requires -Version 99"),
    ];
    const fixture = await createFixture();
    try {
      const candidates = join(fixture.root, "control-flow-candidates.json"); await writeFile(candidates, JSON.stringify(mutants));
      const results = JSON.parse(await runPowerShellScript(`. ${quote(scriptPath)}\n$results=@(foreach($candidate in (Get-Content -LiteralPath ${quote(candidates)} -Raw|ConvertFrom-Json)){$t=$null;$e=$null;[void][Management.Automation.Language.Parser]::ParseInput($candidate,[ref]$t,[ref]$e);[ordered]@{parseErrors=@($e).Count;policy=Test-IntentArcPreflightEnvelopeSourcePolicy -SourceText $candidate}})\nConvertTo-Json -InputObject $results -Compress -Depth 8`));
      expect(results).toHaveLength(mutants.length);
      for (const [index, result] of results.entries()) { expect(mutants[index]).not.toBe(source); expect(result.parseErrors, `mutant ${index}`).toBe(0); expect(result.policy.valid, `mutant ${index}`).toBe(false); }
    } finally { await disposeFixture(fixture); }
  }, 120_000);
  it("public host AuditOnly routes the closed auditor read-only", async () => {
    const fixture = await createFixture();
    try {
      const before = await snapshotFixture(fixture);
      const first = await runTask6Audit(fixture, task6SuccessEvidence(), { host: true });
      const second = await runTask6Audit(fixture, task6SuccessEvidence(), { host: true });
      expect(first.result).toEqual(task5Audit()); expect(second).toEqual(first);
      expect(first.writes).toBe(0); expect(first.controllerStarts).toBe(0);
      expect(first.git).toEqual(["root", "branch", "head", "status"]);
      expect((await snapshotFixture(fixture)).controller).toBe(before.controller);
    } finally { await disposeFixture(fixture); }
  });
  it.each(["-StaticSelfTest", "-TestRoot", "-Contract", "-OperationFactory"])("public host refuses raw internal token %s", async (token) => {
    expectClosedDirectRefusal(await runReviewedDirect([...validPublicTokens(), token, "sensitive-test"], scriptPath));
  });
  it("public host refuses partial and forged internal injection without opening authorization", async () => {
    const fixture = await createFixture();
    try {
      const before = await snapshotFixture(fixture);
      const result = JSON.parse(await runPowerShellScript(`. ${quote(scriptPath)}\n$contract=${contractExpression(fixture)}\n$invocation=[pscustomobject]@{mode='Execute';manifestPath=${quote(fixture.paths.manifest)};expectedSha256='${"0".repeat(64)}'}\n$results=@((Invoke-IntentArcPreflightEnvelopeHost -Invocation $invocation -Contract $contract),(Invoke-IntentArcPreflightEnvelopeHost -Invocation $invocation -Operations ([pscustomobject]@{})),(Invoke-IntentArcPreflightEnvelopeHost -Invocation $invocation -Contract ([pscustomobject]@{Internal=$true;Root=${quote(fixture.root)}}) -Operations ([pscustomobject]@{})))\n[ordered]@{results=$results;opens=$contract.TestHooks.ManifestOpenCount}|ConvertTo-Json -Compress -Depth 8`));
      expect(result.results).toEqual([expectedRefusal, expectedRefusal, expectedRefusal]); expect(result.opens).toBe(0);
      expect(await snapshotFixture(fixture)).toEqual(before);
    } finally { await disposeFixture(fixture); }
  });
  it("source policy rejects forbidden lifecycle and semantic dispatcher mutants without executing them", async () => {
    const source = await readFile(scriptPath, "utf8");
    const calls = ["Start-Process forbidden", "saps forbidden", "Invoke-Expression 'forbidden'", "iex 'forbidden'", "& ('Start-'+'Process') 'forbidden'", "$p=[Diagnostics.Process]::new();$p.Start()", "[Diagnostics.Process]::Start('forbidden')", "$m='Start';$p.$m()", "cmd.exe /c forbidden", "Get-Command pnpm", "$stream.ReadToEnd()", "Get-ChildItem -Recurse out", "Remove-Item -Recurse x", ". ./scripts/signed-release-once.ps1", "Import-Module PKI", "New-SelfSignedCertificate", "certutil.exe -addstore x y", "signtool.exe sign x", "pnpm publish", "npm install", "pnpm update", "pnpm run release", "& $controller -RestoreOnly", "Set-Alias hidden Start-Process; hidden forbidden"];
    const id = "phase1-preflight-20260830-05";
    const paths = [id, `.superpowers\\preflight\\desktop-release\\${id}.json`, `.superpowers\\preflight-out-preservation\\${id}.json`, `.superpowers\\preflight-out-preservation\\${id}`, `.superpowers\\preflight-out-preservation\\${id}\\out`];
    for (const path of paths) for (const expression of [quote(path), `(${quote(path.slice(0, 16))}+${quote(path.slice(16))})`]) {
      for (const call of [`[IO.File]::OpenRead($target)`, `Get-Content -LiteralPath $target`, `Get-FileHash -LiteralPath $target`, `[IO.Directory]::EnumerateFileSystemEntries($target)`]) calls.push(`$target=${expression};${call}`);
    }
    const mutants = calls.flatMap((call) => [source + `\n${call}`, source.replace("function New-IntentArcPreflightExecutionAuthorizationRefusal {", `function New-IntentArcPreflightExecutionAuthorizationRefusal {\n $nested={ ${call} }`)]);
    mutants.push(source.replace("created = process.Start();", "created = alternate.Start();"), source.replace("public enum ProcessRole { GitObservation, Controller }", "public enum ProcessRole { GitObservation, Controller, Other }"), source.replace("controllerGate == null || !controllerGate.TryConsume()", "false"), source.replace("else if (controllerGate != null)", "else if (false)"));
    const fixture = await createFixture();
    try {
      const candidates = join(fixture.root, "candidates.json"); await writeFile(candidates, JSON.stringify(mutants));
      const results = JSON.parse(await runPowerShellScript(`. ${quote(scriptPath)}\n$results=@(foreach($source in (Get-Content -LiteralPath ${quote(candidates)} -Raw|ConvertFrom-Json)){Test-IntentArcPreflightEnvelopeSourcePolicy -SourceText $source})\nConvertTo-Json -InputObject $results -Compress -Depth 8`)) as Array<{valid:boolean;categories:string[]}>;
      expect(results).toHaveLength(mutants.length);
      for (const [index, result] of results.entries()) { expect(result.valid, `mutant ${index}`).toBe(false); expect(result.categories.length).toBeGreaterThan(0); expect(result.categories.every((category) => ["source-structure-invalid", "native-dispatcher-invalid", "source-call-invalid"].includes(category))).toBe(true); }
    } finally { await disposeFixture(fixture); }
  }, 120_000);
});

const task6AuditPathPolicyViolations = async (candidatePath: string) => JSON.parse(await runPowerShellScript([
  `$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile(${quote(candidatePath)},[ref]$tokens,[ref]$errors);$violations=[Collections.Generic.List[string]]::new()`,
  "if(@($errors).Count-ne0){[void]$violations.Add('parse error')}",
  "$targets=@('Read-IntentArcPreflightTerminalAuditProtectedDocument','Read-IntentArcPreflightTerminalAuditProductionEvidence')",
  "foreach($definition in @($ast.FindAll({param($node)$node-is[Management.Automation.Language.FunctionDefinitionAst]-and$targets-ccontains$node.Name},$true))){",
  "foreach($member in @($definition.Body.FindAll({param($node)$node-is[Management.Automation.Language.InvokeMemberExpressionAst]},$true))){if($member.Expression.Extent.Text-ceq'[IO.File]'-and$member.Member.Extent.Text-ceq'ReadAllBytes'){[void]$violations.Add('path-based evidence read')}}",
  "foreach($command in @($definition.Body.FindAll({param($node)$node-is[Management.Automation.Language.CommandAst]},$true))){if(@('Get-Content','gc','type')-ccontains$command.GetCommandName()){[void]$violations.Add('path-based evidence read')}}}",
  "[ordered]@{violations=@($violations)}|ConvertTo-Json -Compress",
].join("\n"))) as { violations: string[] };

const runTask6ProductionAudit = async (fixture: Fixture, mutation: "none" | "missing-result" | "source-identity" | "destination" | "profile-residue" | "malformed-audit" | "git-drift" | "binding-drift" | "stdout-hash" | "stdout-length" | "missing-state" | "invalid-state" | "missing-receipt" | "invalid-receipt" | "result-state-disagreement" | "state-receipt-disagreement" | "stdout-empty" | "stdout-malformed" | "stdout-duplicate" | "stdout-schema-invalid" = "none", options: { stdoutBytes?: number; parentAcl?: boolean; captureMismatch?: boolean } = {}) => {
  const actualGit = "C:\\Program Files\\Git\\cmd\\git.exe";
  const body = [
    "$ErrorActionPreference='Stop'", `. ${quote(scriptPath)}`, "Initialize-IntentArcPreflightExecutionNative",
    `$gitPath=${quote(actualGit)};$repository=${quote(fixture.root)};$mutation=${quote(mutation)}`,
    "& $gitPath init --initial-branch=master --quiet $repository;if($LASTEXITCODE-ne0){throw 'fixture-git-init'}",
    "$tracked=Join-Path $repository 'tracked.txt';[IO.File]::WriteAllText($tracked,'before');& $gitPath -C $repository add -- tracked.txt;if($LASTEXITCODE-ne0){throw 'fixture-git-add'}",
    "& $gitPath -C $repository -c user.name=fixture -c user.email=fixture@example.invalid commit --allow-empty --quiet -m fixture;if($LASTEXITCODE-ne0){throw 'fixture-git-commit'}",
    "$head=((& $gitPath -C $repository rev-parse HEAD)-join'').Trim();if($LASTEXITCODE-ne0-or$head-cnotmatch'^[a-f0-9]{40}$'){throw 'fixture-git-head'}",
    `$pnpmPath=Join-Path $repository 'pnpm.exe';[IO.File]::Copy(${quote(fixture.paths.pnpm)},$pnpmPath);$document=${task5PowerShellJson(fixture.document)};$document.expectedCommit=$head;$document.gitPath=$gitPath;$document.gitSha256=Get-IntentArcPreflightExecutionSha256 -Bytes ([IO.File]::ReadAllBytes($gitPath));$document.pnpmPath=$pnpmPath;$document.pnpmSha256=Get-IntentArcPreflightExecutionSha256 -Bytes ([IO.File]::ReadAllBytes($pnpmPath))`,
    "$manifestBytes=ConvertTo-IntentArcPreflightEnvelopeCanonicalBytes -Document $document;[IO.File]::WriteAllBytes([string]$document.authorizationManifestPath,$manifestBytes);$manifestHash=Get-IntentArcPreflightExecutionSha256 -Bytes $manifestBytes",
    `$bindings=[ordered]@{envelope=${quote(fixture.paths.envelope)};controller=${quote(fixture.paths.controller)};git=$gitPath;node=${quote(fixture.paths.node)};cmd=${quote(fixture.paths.cmd)};pnpm=$pnpmPath;host=${quote(fixture.paths.host)}}`,
    "$contract=New-IntentArcPreflightEnvelopeTestContract -Root $repository -ExecutableBindings $bindings",
    `$invocation=[pscustomobject]@{mode='AuditOnly';manifestPath=${quote(fixture.paths.manifest)};expectedSha256=$manifestHash;InvocationMetadata=[pscustomobject]@{HostImagePath=${quote(fixture.paths.host)};RawCommandLine=('"'+${quote(fixture.paths.host)}+'" -NoProfile -NonInteractive -File "'+${quote(fixture.paths.envelope)}+'" -AuditOnly -AuthorizationManifest "'+${quote(fixture.paths.manifest)}+'" -ExpectedAuthorizationSha256 '+$manifestHash);EnvelopePath=${quote(fixture.paths.envelope)}}}`,
    "$context=Read-IntentArcPreflightExecutionAuthorizationManifest -LiteralPath $document.authorizationManifestPath -ExpectedSha256 $manifestHash -ActualInvocation $invocation -Contract $contract",
    "$superpowers=Join-Path $repository '.superpowers';[void][IO.Directory]::CreateDirectory($superpowers);$source=Join-Path $repository 'out';[void][IO.Directory]::CreateDirectory($source)",
    "$sourceGuard=[IntentArc.PreflightEnvelope.BoundaryGuard]::OpenDirectoryForAudit($source,$source);$sourceIdentity=$sourceGuard.StableIdentity;$sourceGuard.Dispose()",
    "$preservationPath=Join-Path $superpowers 'preflight-out-preservation';$preservation=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::CreateExclusiveRoot($superpowers,'preflight-out-preservation')",
    `$state=${task5PowerShellJson(task5State())};$state.sourcePath=$source;$state.destinationPath=Join-Path (Join-Path $preservationPath $document.controllerRunId) 'out';$state.directory.canonicalPath=$source;$state.directory.stableIdentity=if($mutation-ceq'source-identity'){'00000001:0000000000000001'}else{$sourceIdentity};$state.ownedRoots.profile.canonicalPath=Join-Path (Join-Path $preservationPath $document.controllerRunId) 'profile';$state.ownedRoots.localAppData.canonicalPath=Join-Path (Join-Path $preservationPath $document.controllerRunId) 'localappdata';$state.pnpm.path=$document.pnpmPath;$state.pnpm.sha256=$document.pnpmSha256;$state.expectedCommit=$head;$state.child.rootProcessId=$PID`,
    "if($mutation-ceq'result-state-disagreement'){$state.child.exitCode=7};$stateBytes=if($mutation-ceq'invalid-state'){[Text.Encoding]::UTF8.GetBytes('{}')}else{ConvertTo-IntentArcPreflightEnvelopeCanonicalBytes -Document $state};$stateHash=Get-IntentArcPreflightExecutionSha256 -Bytes $stateBytes;if($mutation-cne'missing-state'){$stateFile=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::WriteAtomicNew($preservation,($document.controllerRunId+'.json'),$stateBytes);$stateFile.Dispose()};$preservation.Dispose()",
    "$preflight=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::CreateExclusiveRoot($superpowers,'preflight');$preflightPath=Join-Path $superpowers 'preflight';$preflight.Dispose();$receiptRoot=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::CreateExclusiveRoot($preflightPath,'desktop-release')",
    `$id06Receipt=${task5PowerShellJson(task5Receipt())};if($mutation-ceq'state-receipt-disagreement'){$id06Receipt.status='failed';$id06Receipt.failureCategory='focused-tests';$id06Receipt.checks.'focused-tests'='failed'};$receiptBytes=if($mutation-ceq'invalid-receipt'){[Text.Encoding]::UTF8.GetBytes('{}')}else{ConvertTo-IntentArcPreflightEnvelopeCanonicalBytes -Document $id06Receipt};$receiptHash=Get-IntentArcPreflightExecutionSha256 -Bytes $receiptBytes;if($mutation-cne'missing-receipt'){$receiptFile=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::WriteAtomicNew($receiptRoot,($document.controllerRunId+'.json'),$receiptBytes);$receiptFile.Dispose()};$receiptRoot.Dispose()`,
    "$attemptParent=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::CreateExclusiveRoot($superpowers,'preflight-execution-envelope');$attemptParentPath=Join-Path $superpowers 'preflight-execution-envelope';$attemptParent.Dispose();$attemptRoot=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::CreateExclusiveRoot($attemptParentPath,$document.attemptId)",
    "$authorizationFile=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::WriteAtomicNew($attemptRoot,'authorization.json',$manifestBytes);$authorizationFile.Dispose()",
    `$consumed=[ordered]@{schema='intentarc.preflight-execution-consumed/v1';attemptId=$document.attemptId;authorizationSha256=$manifestHash;consumedAtUtc=${quote(task5Timestamp(0))};controllerLaunchStatus='attempted'};$consumedBytes=ConvertTo-IntentArcPreflightEnvelopeCanonicalBytes -Document $consumed;$consumedHash=Get-IntentArcPreflightExecutionSha256 -Bytes $consumedBytes;$consumedFile=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::WriteAtomicNew($attemptRoot,'consumed.json',$consumedBytes);$consumedFile.Dispose()`,
    `$started=[ordered]@{schema='intentarc.preflight-execution-controller-started/v1';attemptId=$document.attemptId;controllerRunId=$document.controllerRunId;authorizationSha256=$manifestHash;consumedSha256=$consumedHash;controllerProcessId=$PID;controllerStartTimeUtc=${quote(task5Timestamp(1))};recordedAtUtc=${quote(task5Timestamp(2))}};$startedBytes=ConvertTo-IntentArcPreflightEnvelopeCanonicalBytes -Document $started;$startedFile=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::WriteAtomicNew($attemptRoot,'controller-started.json',$startedBytes);$startedFile.Dispose()`,
    `$result=${task5PowerShellJson(task5Result())};$resultBytes=switch($mutation){'stdout-empty'{break}'stdout-malformed'{[Text.Encoding]::UTF8.GetBytes('{');break}'stdout-duplicate'{[Text.Encoding]::UTF8.GetBytes('{"schema":"intentarc.preflight-out-preservation-result/v2","schema":"intentarc.preflight-out-preservation-result/v2"}');break}'stdout-schema-invalid'{[Text.Encoding]::UTF8.GetBytes('{"schema":"wrong"}');break}default{ConvertTo-IntentArcPreflightEnvelopeCanonicalBytes -Document $result}};$resultBytes=[byte[]]@($resultBytes);if(${options.stdoutBytes !== undefined ? '$true' : '$false'}){$padded=[byte[]]::new(${options.stdoutBytes ?? 0});for($i=0;$i-lt$padded.Length;$i++){$padded[$i]=32};[Array]::Copy($resultBytes,$padded,$resultBytes.Length);$resultBytes=$padded};$resultHash=Get-IntentArcPreflightExecutionSha256 -Bytes $resultBytes;if($mutation-cne'missing-result'){$stdoutFile=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::WriteAtomicNew($attemptRoot,'controller-stdout.json',$resultBytes);$stdoutFile.Dispose()}`,
    `$attemptReceipt=${task5PowerShellJson(task5AttemptReceipt())};$attemptReceipt.controllerProcessId=$PID;$attemptReceipt.controllerStartTimeUtc=${quote(task5Timestamp(1))};$attemptReceipt.controllerStartedAtUtc=${quote(task5Timestamp(1))};$attemptReceipt.stdoutBytes=if($mutation-ceq'stdout-length'){[long]$resultBytes.Length+1}else{[long]$resultBytes.Length};$attemptReceipt.stdoutSha256=if($mutation-ceq'stdout-hash'){'e'*64}else{$resultHash};$attemptReceipt.stdoutOverflow=$attemptReceipt.stdoutBytes-gt1048576;if($attemptReceipt.stdoutOverflow){$attemptReceipt.infrastructureCategory='capture-overflow'};if(${options.captureMismatch ? '$true' : '$false'}){$attemptReceipt.stdoutSha256='e'*64};$attemptReceiptBytes=ConvertTo-IntentArcPreflightEnvelopeCanonicalBytes -Document $attemptReceipt;$attemptReceiptFile=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::WriteAtomicNew($attemptRoot,'attempt-receipt.json',$attemptReceiptBytes);$attemptReceiptFile.Dispose();if($mutation-ceq'malformed-audit'){$badAudit=[Text.Encoding]::UTF8.GetBytes('{}');$badAuditFile=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::WriteAtomicNew($attemptRoot,'audit-result.json',$badAudit);$badAuditFile.Dispose()};$attemptRoot.Dispose()`,
    `if(${options.parentAcl ? '$true' : '$false'}){$acl=[Security.AccessControl.DirectorySecurity]::new();$acl.SetAccessRuleProtection($true,$false);[void]$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.WindowsIdentity]::GetCurrent().User,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.AccessControlType]::Allow));[void]$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.AccessControlType]::Allow));[IO.Directory]::SetAccessControl($attemptParentPath,$acl)}`,
    "$runRoot=Join-Path $preservationPath $document.controllerRunId;if($mutation-ceq'destination'){[void][IO.Directory]::CreateDirectory((Join-Path $runRoot 'out'))};if($mutation-ceq'profile-residue'){[void][IO.Directory]::CreateDirectory((Join-Path $runRoot 'profile'))}",
    "if($mutation-ceq'git-drift'){[IO.File]::WriteAllText($tracked,'after')};if($mutation-ceq'binding-drift'){$context.Document.envelopeSha256='f'*64}",
    "$gitCalls=[Collections.Generic.List[string]]::new();$productionGit=${function:Invoke-IntentArcPreflightGitObservation}",
    "function Invoke-IntentArcPreflightGitObservation { param($AuthorizationDocument,[string]$Observation,[string]$Fault);[void]$gitCalls.Add($Observation);& $productionGit -AuthorizationDocument $AuthorizationDocument -Observation $Observation -Fault $Fault }",
    "$firstOperations=New-IntentArcPreflightTerminalAuditProductionOperations -AuthorizationContext $context;try{$first=Invoke-IntentArcPreflightEnvelopeAuditOnly -AuthorizationContext $context -Operations $firstOperations}finally{$firstOperations.DisposeEvidenceGuards()}",
    "$secondOperations=New-IntentArcPreflightTerminalAuditProductionOperations -AuthorizationContext $context;try{$second=Invoke-IntentArcPreflightEnvelopeAuditOnly -AuthorizationContext $context -Operations $secondOperations}finally{$secondOperations.DisposeEvidenceGuards()}",
    "$auditPath=Join-Path (Join-Path $attemptParentPath $document.attemptId) 'audit-result.json';$auditDisposition=[string][IntentArc.PreflightEnvelope.EntryProbe]::Probe($auditPath);$context.Dispose()",
    "[ordered]@{first=$first;second=$second;git=@($gitCalls);auditDisposition=$auditDisposition;resultHash=$resultHash;stateHash=$stateHash;receiptHash=$receiptHash}|ConvertTo-Json -Compress -Depth 12",
  ].join("\n");
  return JSON.parse(await runPowerShellScript(body)) as {
    first: Record<string, unknown>; second: Record<string, unknown>; git: string[]; auditDisposition: string;
    resultHash: string; stateHash: string; receiptHash: string;
  };
};

describe.sequential("Task 8 final review fixes", () => {
  it("preserves non-ASCII literals and paths in generated Windows PowerShell files", async () => {
    const root = await mkdtemp(join(tmpdir(), "intentarc é 漢 "));
    try {
      expect(JSON.parse(await runPowerShellScript(`$p=${quote(root)};[ordered]@{exists=[IO.Directory]::Exists($p);code=[int]('é'[0])}|ConvertTo-Json -Compress`)))
        .toEqual({ exists: true, code: 233 });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([65536, 65537, 1048576, 1048577])("separates protected raw capture from result validation at %i bytes", async (stdoutBytes) => {
    const fixture = await createFixture();
    try {
      const answer = await runTask6ProductionAudit(fixture, "none", { stdoutBytes });
      expect(answer.first).toMatchObject({
        category: stdoutBytes === 65536 ? "none" : stdoutBytes <= 1048576 ? "controller-result-invalid" : "controller-capture-invalid",
        attemptConsumed: true, controllerStarted: true, controllerExitCode: 0,
        resultSha256: stdoutBytes === 65536 ? answer.resultHash : null,
        stateSha256: stdoutBytes === 65536 ? answer.stateHash : null, receiptSha256: stdoutBytes === 65536 ? answer.receiptHash : null,
      });
      expect(answer.second).toEqual(answer.first);
      expect(answer.auditDisposition).toBe("Absent");
    } finally { await disposeFixture(fixture); }
  }, 30_000);

  it("gives receipt capture mismatch precedence over oversized result", async () => {
    const fixture = await createFixture();
    try {
      const answer = await runTask6ProductionAudit(fixture, "none", { stdoutBytes: 65537, captureMismatch: true });
      expect(answer.first).toMatchObject({ category: "controller-capture-invalid", resultSha256: null, controllerExitCode: 0 });
    } finally { await disposeFixture(fixture); }
  }, 30_000);

  it("rejects parent-only DACL drift without repairing AuditOnly evidence", async () => {
    const fixture = await createFixture();
    try {
      const answer = await runTask6ProductionAudit(fixture, "none", { parentAcl: true });
      expect(answer.first).toMatchObject({ category: "attempt-evidence-invalid", attemptConsumed: false, controllerStarted: false, controllerExitCode: null, resultSha256: null });
      expect(answer.second).toEqual(answer.first);
      expect(answer.auditDisposition).toBe("Absent");
    } finally { await disposeFixture(fixture); }
  }, 30_000);

  it.each(["collision", "post-promotion-flush", "receipt-collision"] as const)("independently finalizes receipt after stdout persistence %s", async (fault) => {
    const fixture = await createFixture();
    try {
      let source = await readFile(scriptPath, "utf8");
      if (fault === "post-promotion-flush") {
        const needle = "        temporaryGuard.FlushDurable();\n        root.FlushDurable();";
        const patched = source.replace(needle, '        temporaryGuard.FlushDurable();\n        if (destination.EndsWith("\\\\controller-stdout.json", StringComparison.OrdinalIgnoreCase)) throw new IOException("fixture-post-promotion-flush");\n        root.FlushDurable();');
        expect(patched).not.toBe(source); source = patched;
      }
      const candidate = join(fixture.root, "finalizer.ps1"); await writeFile(candidate, source, "utf8");
      const answer = JSON.parse(await runPowerShellScript([
        "$ErrorActionPreference='Stop'", `. ${quote(candidate)}`, "Initialize-IntentArcPreflightExecutionNative",
        `$guard=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::CreateExclusiveRoot(${quote(fixture.root)},'evidence')`,
        "$consumed=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::WriteAtomicNew($guard,'consumed.json',[byte[]](99));$consumed.Dispose()",
        `if(${fault !== "post-promotion-flush" ? "$true" : "$false"}){$collision=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::WriteAtomicNew($guard,'controller-stdout.json',[byte[]](120));$collision.Dispose()}`,
        `if(${fault === "receipt-collision" ? "$true" : "$false"}){$collision=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::WriteAtomicNew($guard,'attempt-receipt.json',[byte[]](121));$collision.Dispose()}`,
        "$flags=[Reflection.BindingFlags]'Instance,NonPublic';$type=[IntentArc.PreflightEnvelope.NativeProcessSupervisor];$supervisor=$type.GetConstructors($flags)[0].Invoke(@([Diagnostics.Process]::GetCurrentProcess(),[int]12345,'2026-09-02T00:00:01.000Z',$null,$null,$false))",
        "foreach($pair in @(@('SettlementComplete',$true),@('CaptureComplete',$true),@('ExitCode',[int]0),@('StartedObservedAtUtc','2026-09-02T00:00:01.000Z'),@('CaptureCompletedAtUtc','2026-09-02T00:00:02.000Z'),@('ExitedAtUtc','2026-09-02T00:00:02.000Z'))){$type.GetField($pair[0],$flags).SetValue($supervisor,$pair[1])}",
        "function Receive-IntentArcPreflightControllerOutput {param($Supervisor,$MaximumStdoutBytes,$MaximumStderrBytes);[pscustomobject][ordered]@{stdout=[byte[]](123,125);stdoutBytes=[long]2;stdoutSha256=(Get-IntentArcPreflightExecutionSha256 -Bytes ([byte[]](123,125)));stderrBytes=[long]0;stderrSha256=(Get-IntentArcPreflightExecutionSha256 -Bytes ([byte[]]::new(0)));stdoutOverflow=$false;stderrOverflow=$false}}",
        "$writer=${function:Write-IntentArcPreflightEnvelopeAttemptReceipt};$script:writes=0;function Write-IntentArcPreflightEnvelopeAttemptReceipt {param($RootGuard,$Document);$script:writes++;& $writer -RootGuard $RootGuard -Document $Document}",
        "$launch=[pscustomobject][ordered]@{processCreated=$true;nonCreationProven=$false;supervisor=$supervisor;supervisorIdentityValid=$true;drainsInitialized=$true;setupCategory='none'};$failure=$null;try{[void](Finalize-IntentArcPreflightControllerAttempt -RootGuard $guard -Launch $launch -ControllerStartedValid $true -LaunchAttemptedAtUtc '2026-09-02T00:00:00.000Z')}catch{$failure=$_.Exception.Message}",
        `$root=${quote(join(fixture.root, "evidence"))};$guard.Dispose();$receiptPath=Join-Path $root 'attempt-receipt.json';$receipt=if([IO.File]::Exists($receiptPath)){[Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($receiptPath))}else{$null};[ordered]@{writes=$script:writes;failure=$failure;receipt=$receipt;stdout=[Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $root 'controller-stdout.json')));consumed=[Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $root 'consumed.json')))}|ConvertTo-Json -Compress`,
      ].join("\n"))) as { writes: number; failure: string | null; receipt: string | null; stdout: string; consumed: string };
      expect(answer.writes).toBe(1); expect(answer.consumed).toBe("Yw==");
      expect(answer.stdout).toBe(fault === "post-promotion-flush" ? "e30=" : "eA==");
      if (fault === "receipt-collision") { expect(answer.receipt).toBe("y"); expect(answer.failure).not.toBeNull(); }
      else {
        expect(answer.failure).toBeNull();
        expect(JSON.parse(answer.receipt!)).toMatchObject({ infrastructureCategory: "capture-invalid", processSettled: true, controllerProcessId: 12345, controllerExitCode: 0, stdoutBytes: 2, stdoutSha256: sha256("{}"), stdoutEof: true, stderrEof: true });
      }
    } finally { await disposeFixture(fixture); }
  });

  it.each(["settled", "uncertain", "creation-exception"] as const)("pins TEMP identity through %s process lifetime", async (kind) => {
    const fixture = await createFixture();
    try {
      const temp = join(fixture.root, "environment"); await mkdir(temp);
      const source = (await readFile(scriptPath, "utf8"))
        .replaceAll("C:\\\\Users\\\\synthetic-user\\\\AppData\\\\Local\\\\Temp", temp.replaceAll("\\", "\\\\"))
        .replaceAll("C:\\Users\\synthetic-user\\AppData\\Local\\Temp", temp);
      const candidate = join(fixture.root, "temp-lifetime.ps1"); await writeFile(candidate, source, "utf8");
      const answer = JSON.parse(await runPowerShellScript([
        "$ErrorActionPreference='Stop'", `. ${quote(candidate)}`, "Initialize-IntentArcPreflightExecutionNative",
        `$temp=${quote(temp)};$moved=$temp+'-moved';$document=${task5PowerShellJson({ ...fixture.document, gitPath: "C:\\Program Files\\Git\\cmd\\git.exe" })}`,
        "$info=New-IntentArcPreflightGitObservationStartInfo -AuthorizationDocument $document -Observation root;$bindings=New-IntentArcPreflightGitObservationBindings -AuthorizationDocument $document;$launch=$null",
        `try{$launch=[IntentArc.PreflightEnvelope.NativeProcessDispatcher]::Run([IntentArc.PreflightEnvelope.ProcessRole]::GitObservation,$info,$bindings,$null,${quote(kind === "settled" ? "" : kind === "uncertain" ? "wait-for-exit" : "process-start-exception")})}catch{if(${kind === "creation-exception" ? '$false' : '$true'}){throw $_}}`,
        "$before=$false;try{[IO.Directory]::Move($temp,$moved);[IO.Directory]::Move($moved,$temp)}catch{$before=$true};if($null-ne$launch){try{[void](Receive-IntentArcPreflightControllerOutput -Supervisor $launch.supervisor -MaximumStdoutBytes 1048576 -MaximumStderrBytes 1048576)}catch{}};$after=$false;try{[IO.Directory]::Move($temp,$moved);[IO.Directory]::Move($moved,$temp)}catch{$after=$true};[ordered]@{beforeBlocked=$before;afterBlocked=$after}|ConvertTo-Json -Compress",
      ].join("\n")));
      expect(answer).toEqual({ beforeBlocked: true, afterBlocked: kind !== "settled" });
    } finally { await disposeFixture(fixture); }
  });

  it.each(["ordinary", "missing", "inaccessible", "final-reparse", "ancestor-reparse"] as const)("guards fixed TEMP before first process creation for %s paths", async (kind) => {
    const fixture = await createFixture();
    const parent = join(fixture.root, "environment"); const target = join(fixture.root, "target");
    try {
      await mkdir(target); await mkdir(join(target, "temp"));
      if (kind === "ancestor-reparse") await symlink(target, parent, "junction");
      else await mkdir(parent);
      const temp = join(parent, "temp");
      if (kind === "final-reparse") await symlink(target, temp, "junction");
      else if (kind !== "missing" && kind !== "ancestor-reparse") await mkdir(temp);
      const source = (await readFile(scriptPath, "utf8"))
        .replaceAll("C:\\\\Users\\\\synthetic-user\\\\AppData\\\\Local\\\\Temp", temp.replaceAll("\\", "\\\\"))
        .replaceAll("C:\\Users\\synthetic-user\\AppData\\Local\\Temp", temp);
      const candidate = join(fixture.root, "temp-boundary.ps1"); await writeFile(candidate, source, "utf8");
      const answer = JSON.parse(await runPowerShellScript([
        "$ErrorActionPreference='Stop'", `. ${quote(candidate)}`, "Initialize-IntentArcPreflightExecutionNative",
        `$temp=${quote(temp)};$saved=$null;if(${kind === "inaccessible" ? "$true" : "$false"}){$saved=[IO.Directory]::GetAccessControl($temp);$acl=[IO.Directory]::GetAccessControl($temp);[void]$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.WindowsIdentity]::GetCurrent().User,[Security.AccessControl.FileSystemRights]::ReadAndExecute,[Security.AccessControl.AccessControlType]::Deny));[IO.Directory]::SetAccessControl($temp,$acl)}`,
        `$document=${task5PowerShellJson({ ...fixture.document, gitPath: "C:\\Program Files\\Git\\cmd\\git.exe", outerPowerShellPath: powerShell, controllerPath: join(fixture.root, "scripts", "desktop-release-preflight-out-preservation.ps1") })}`,
        "$answers=@();try{foreach($role in @('GitObservation','Controller')){$rejected=$false;$launch=$null;try{if($role-ceq'GitObservation'){$info=New-IntentArcPreflightGitObservationStartInfo -AuthorizationDocument $document -Observation root;$bindings=New-IntentArcPreflightGitObservationBindings -AuthorizationDocument $document;$gate=$null}else{$info=New-IntentArcPreflightControllerStartInfo -AuthorizationDocument $document;$bindings=New-IntentArcPreflightControllerLaunchBindings -AuthorizationDocument $document;$gate=New-IntentArcPreflightControllerLaunchGate -DurableConsumptionValidated $true};$launch=[IntentArc.PreflightEnvelope.NativeProcessDispatcher]::Run([IntentArc.PreflightEnvelope.ProcessRole]::$role,$info,$bindings,$gate,'pre-creation-failure')}catch{$rejected=$true};$answers+=@{role=$role;rejected=$rejected;created=($null-ne$launch-and$launch.processCreated)}}}finally{if($null-ne$saved){[IO.Directory]::SetAccessControl($temp,$saved)}};$answers|ConvertTo-Json -Compress",
      ].join("\n"))) as Array<{ role: string; rejected: boolean; created: boolean }>;
      expect(answer).toEqual(["GitObservation", "Controller"].map((role) => ({ role, rejected: kind !== "ordinary", created: false })));
    } finally {
      if (kind === "final-reparse") await rmdir(join(parent, "temp"));
      if (kind === "ancestor-reparse") await rmdir(parent);
      await disposeFixture(fixture);
    }
  });
});

describe.sequential("desktop release preflight once Task 6 terminal audit", () => {
  it("holds restoration identity with attributes-only read/write sharing and no delete-share flag", async () => {
    const fixture = await createFixture();
    try {
      const out = join(fixture.root, "task6 out"); const child = join(out, "opaque-created-by-owner.bin");
      await mkdir(out);
      const result = await runBoundaryHarness([
        `$guard=[IntentArc.PreflightEnvelope.BoundaryGuard]::OpenDirectoryForAudit(${quote(out)},${quote(out)})`,
        `$writeSucceeded=$false;try{[IO.File]::WriteAllBytes(${quote(child)},[byte[]](1,2,3));$writeSucceeded=$true}catch{}`,
        "$stable=$guard.Revalidate();$guard.Dispose()",
        "[ordered]@{writeSucceeded=$writeSucceeded;stable=$stable}|ConvertTo-Json -Compress",
      ].join("\n"));
      expect(result).toEqual({ writeSucceeded: true, stable: true });
      const source = await readFile(scriptPath, "utf8");
      expect(source).toContain("return new BoundaryGuard(path, expectedFinalPath, true, 0u, null, false, true, false);");
    } finally { await disposeFixture(fixture); }
  }, 30_000);

  it("acquires every terminal fact from protected disposable production evidence and performs exactly four real Git observations per AuditOnly run", async () => {
    const fixture = await createFixture();
    try {
      const answer = await runTask6ProductionAudit(fixture);
      expect(answer.first).toEqual(answer.second);
      expect(answer.first).toMatchObject({
        status: "AUDITED-PASS", category: "none", attemptConsumed: true, controllerStarted: true,
        controllerExitCode: 0, resultSha256: answer.resultHash, stateSha256: answer.stateHash,
        receiptSha256: answer.receiptHash, outRestored: true, cleanupComplete: true, gitClean: true, bindingsValid: true,
      });
      expect(answer.git).toEqual(["root", "branch", "head", "status", "root", "branch", "head", "status"]);
      expect(answer.auditDisposition).toBe("Absent");
    } finally { await disposeFixture(fixture); }
  }, 120_000);

  it.each([
    ["missing-result", "controller-capture-invalid"],
    ["source-identity", "out-restoration-invalid"],
    ["destination", "out-restoration-invalid"],
    ["profile-residue", "cleanup-invalid"],
    ["malformed-audit", "attempt-evidence-invalid"],
    ["git-drift", "repository-invalid"],
    ["binding-drift", "binding-invalid"],
    ["stdout-hash", "controller-capture-invalid"],
    ["stdout-length", "controller-capture-invalid"],
    ["missing-state", "controller-state-invalid"],
    ["invalid-state", "controller-state-invalid"],
    ["missing-receipt", "controller-receipt-invalid"],
    ["invalid-receipt", "controller-receipt-invalid"],
    ["result-state-disagreement", "controller-state-invalid"],
    ["state-receipt-disagreement", "controller-receipt-invalid"],
    ["stdout-empty", "controller-result-invalid"],
    ["stdout-malformed", "controller-result-invalid"],
    ["stdout-duplicate", "controller-result-invalid"],
    ["stdout-schema-invalid", "controller-result-invalid"],
  ] as const)("derives %s from adverse protected production evidence", async (mutation, category) => {
    const fixture = await createFixture();
    try {
      const answer = await runTask6ProductionAudit(fixture, mutation);
      expect(answer.first.category).toBe(category);
      expect(answer.second).toEqual(answer.first);
      expect(answer.git).toEqual(["root", "branch", "head", "status", "root", "branch", "head", "status"]);
      expect(answer.auditDisposition).toBe(mutation === "malformed-audit" ? "Present" : "Absent");
    } finally { await disposeFixture(fixture); }
  }, 120_000);

  it("maps an indeterminate protected-document probe to stage-specific invalid evidence", async () => {
    const fixture = await createFixture();
    try {
      const answer = JSON.parse(await runPowerShellScript([
        `. ${quote(scriptPath)}`, "Initialize-IntentArcPreflightExecutionNative",
        `$rootPath=Join-Path ${quote(fixture.root)} 'task6-probe-root';[void][IO.Directory]::CreateDirectory($rootPath);$leaf=Join-Path $rootPath 'consumed.json';[IO.File]::WriteAllBytes($leaf,[byte[]](1,2,3))`,
        "$rootGuard=[IntentArc.PreflightEnvelope.BoundaryGuard]::OpenDirectory($rootPath,$rootPath);$lock=[IO.FileStream]::new($leaf,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None);$guards=[Collections.Generic.List[IDisposable]]::new()",
        "try{$result=Read-IntentArcPreflightTerminalAuditProtectedDocument -RootGuard $rootGuard -RootPath $rootPath -Leaf 'consumed.json' -MaximumBytes 16384 -Schema 'consumption' -Guards $guards}finally{$lock.Dispose();$rootGuard.Dispose()}",
        "$result|ConvertTo-Json -Compress",
      ].join("\n"))) as { disposition: string; value: unknown };
      expect(answer).toEqual({ disposition: "invalid", value: null });
    } finally { await disposeFixture(fixture); }
  });

  it("matches a live PID at recorded millisecond precision and rejects a definite different millisecond", async () => {
    const fixture = await createFixture();
    try {
      const answer = JSON.parse(await runPowerShellScript([
        `. ${quote(scriptPath)}`, "Initialize-IntentArcPreflightExecutionNative",
        "$process=[Diagnostics.Process]::GetCurrentProcess();$text=$process.StartTime.ToUniversalTime().ToString(\"yyyy-MM-ddTHH:mm:ss.fff'Z'\",[Globalization.CultureInfo]::InvariantCulture)",
        "$recorded=[DateTimeOffset]::ParseExact($text,\"yyyy-MM-ddTHH:mm:ss.fff'Z'\",[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::AssumeUniversal).UtcDateTime.ToFileTimeUtc()",
        "$same=[string][IntentArc.PreflightEnvelope.ProcessProbe]::ProbeAtMillisecondPrecision($PID,$recorded);$different=[string][IntentArc.PreflightEnvelope.ProcessProbe]::ProbeAtMillisecondPrecision($PID,($recorded+10000))",
        "[ordered]@{same=$same;different=$different}|ConvertTo-Json -Compress",
      ].join("\n"))) as { same: string; different: string };
      expect(answer).toEqual({ same: "Present", different: "Absent" });
      const activeController = await runTask6Audit(fixture, { ...task6SuccessEvidence(), controllerProcessDisposition: answer.same.toLowerCase() as "present" });
      const activeChild = await runTask6Audit(fixture, { ...task6SuccessEvidence(), childProcessDisposition: answer.same.toLowerCase() as "present" });
      expect(activeController.result.category).toBe("child-settlement-invalid"); expect(activeChild.result.category).toBe("child-settlement-invalid");
    } finally { await disposeFixture(fixture); }
  });

  const categoryCases: Array<[string, Partial<Task6Evidence>, Parameters<typeof runTask6Audit>[2]?]> = [
    ["attempt-not-consumed", { attemptRootDisposition: "absent", authorizationCopyValid: false, consumptionDisposition: "absent", controllerStartedDisposition: "absent", attemptReceiptDisposition: "absent" }],
    ["attempt-evidence-invalid", { consumptionDisposition: "invalid" }],
    ["controller-not-started", { controllerStartedDisposition: "absent", attemptReceiptDisposition: "valid", receiptInfrastructureCategory: "launch-failed", controllerExitCode: null, controllerStdoutDisposition: "absent", resultDisposition: "absent", resultSha256: null, stateDisposition: "absent", stateSha256: null, id06ReceiptDisposition: "absent", receiptSha256: null, controllerProcessDisposition: "not-applicable", childProcessDisposition: "not-applicable" }],
    ["controller-outcome-uncertain", { attemptReceiptDisposition: "absent", receiptInfrastructureCategory: null, controllerExitCode: null }],
    ["controller-capture-invalid", { receiptInfrastructureCategory: "capture-invalid", controllerExitCode: 0, controllerStdoutDisposition: "invalid", resultDisposition: "absent", resultSha256: null, stateDisposition: "absent", stateSha256: null, id06ReceiptDisposition: "absent", receiptSha256: null }],
    ["controller-result-invalid", { resultDisposition: "not-candidate" }],
    ["controller-state-invalid", { stateDisposition: "invalid" }],
    ["controller-receipt-invalid", { id06ReceiptDisposition: "invalid" }],
    ["child-settlement-invalid", { childProcessDisposition: "present" }],
    ["out-restoration-invalid", { sourceStableIdentityValid: false }],
    ["cleanup-invalid", { cleanupResidueDispositions: ["absent", "present", "absent"] }],
    ["repository-invalid", {}, { git: { branch: { exitCode: 0, stderrBytes: 0, overflow: false, stdout: "feature\n" } } }],
    ["binding-invalid", { bindingsDisposition: "invalid" }],
    ["audit-infrastructure-invalid", { infrastructureValid: false }],
    ["none", {}],
  ];

  it.each(categoryCases)("resolves audit precedence category %s with the exact 16-key projection", async (category, overrides, options) => {
    const fixture = await createFixture();
    try {
      const answer = await runTask6Audit(fixture, { ...task6SuccessEvidence(), ...overrides }, options);
      expect(Object.keys(answer.result)).toEqual(auditKeys); expect(answer.result).toEqual(task6Expected(category)); expect(answer.valid).toBe(true);
    } finally { await disposeFixture(fixture); }
  });

  it("self-validates an impossible null-exit public projection", async () => {
    const fixture = await createFixture();
    try {
      const missingExit = await runTask6Audit(fixture, { ...task6SuccessEvidence(), controllerExitCode: null });
      expect(missingExit.result.category).toBe("attempt-evidence-invalid"); expect(missingExit.valid).toBe(true);
    } finally { await disposeFixture(fixture); }
  });

  it("classifies malformed internal operations as infrastructure without erasing admitted authorization", async () => {
    const fixture = await createFixture();
    try {
      const malformedOperations = await runTask6Audit(fixture, task6SuccessEvidence(), { malformedOperations: true });
      expect(malformedOperations.result).toEqual({ ...task6Expected("audit-infrastructure-invalid"), expectedCommit: task5Commit });
      expect(malformedOperations.valid).toBe(true);
      const nullOperations = await runTask6Audit(fixture, task6SuccessEvidence(), { nullOperations: true });
      expect(nullOperations.result).toEqual({ ...task6Expected("audit-infrastructure-invalid"), expectedCommit: task5Commit });
      expect(nullOperations.valid).toBe(true);
      const auditOnlyNullOperations = await runTask6Audit(fixture, task6SuccessEvidence(), { mode: "AuditOnly", nullOperations: true });
      expect(auditOnlyNullOperations.result).toEqual({ ...task6Expected("audit-infrastructure-invalid"), expectedCommit: task5Commit });
      expect(auditOnlyNullOperations.valid).toBe(true);
      expect(auditOnlyNullOperations.writes + auditOnlyNullOperations.controllerStarts + auditOnlyNullOperations.cleanupCalls).toBe(0);
      const malformedAuthorization = await runTask6Audit(fixture, task6SuccessEvidence(), { malformedAuthorization: true });
      expect(malformedAuthorization.result).toEqual(expectedRefusal);
      expect(malformedAuthorization.valid).toBe(true);
    } finally { await disposeFixture(fixture); }
  });

  it("gives earlier safety faults precedence and preserves the supervisor-identity-invalid special row", async () => {
    const fixture = await createFixture();
    try {
      const pairs: Array<[string, Partial<Task6Evidence>]> = [
        ["attempt-evidence-invalid", { consumptionDisposition: "invalid", resultDisposition: "invalid", cleanupResidueDispositions: ["present", "absent", "absent"] }],
        ["controller-capture-invalid", { receiptInfrastructureCategory: "capture-overflow", resultDisposition: "invalid" }],
        ["out-restoration-invalid", { sourceParentIdentityValid: false, cleanupResidueDispositions: ["present", "absent", "absent"] }],
      ];
      for (const [category, overrides] of pairs) expect((await runTask6Audit(fixture, { ...task6SuccessEvidence(), ...overrides })).result.category).toBe(category);
      const special = { ...task6SuccessEvidence(), controllerStartedDisposition: "absent" as const, startedReceiptIdentityValid: false,
        supervisorIdentityInvalidShape: true, receiptInfrastructureCategory: "settlement-invalid" as const, controllerExitCode: null,
        controllerStdoutDisposition: "absent" as const, resultDisposition: "absent" as const, resultSha256: null,
        stateDisposition: "absent" as const, stateSha256: null, id06ReceiptDisposition: "absent" as const, receiptSha256: null,
        controllerProcessDisposition: "not-applicable" as const, childProcessDisposition: "not-applicable" as const };
      expect((await runTask6Audit(fixture, special)).result).toEqual({ ...task6Expected("controller-outcome-uncertain"), controllerStarted: false });
      const settledIdentity = { ...task6SuccessEvidence(), receiptInfrastructureCategory: "settlement-invalid" as const,
        controllerExitCode: null, controllerStdoutDisposition: "absent" as const, resultDisposition: "absent" as const,
        resultSha256: null, stateDisposition: "absent" as const, stateSha256: null, id06ReceiptDisposition: "absent" as const, receiptSha256: null };
      expect((await runTask6Audit(fixture, settledIdentity)).result).toEqual({ ...task6Expected("controller-outcome-uncertain"), controllerStarted: true });
      expect((await runTask6Audit(fixture, { ...task6SuccessEvidence(), controllerExitCode: 7 })).result.category).toBe("controller-result-invalid");
    } finally { await disposeFixture(fixture); }
  }, 30_000);

  it("proves every required stage boundary with non-tautological pairwise and multifault evidence", async () => {
    const fixture = await createFixture();
    try {
      const dirtyBranch = { branch: { exitCode: 0, stderrBytes: 0, overflow: false, stdout: "feature\n" } };
      const cases: Array<[string, Partial<Task6Evidence>, Parameters<typeof runTask6Audit>[2]?]> = [
        ["attempt-not-consumed", { attemptRootDisposition: "absent", authorizationCopyValid: false, consumptionDisposition: "invalid", cleanupResidueDispositions: ["present", "absent", "absent"] }],
        ["attempt-evidence-invalid", { consumptionDisposition: "invalid", controllerStartedDisposition: "absent", attemptReceiptDisposition: "valid", receiptInfrastructureCategory: "launch-failed", controllerExitCode: null, resultDisposition: "invalid" }],
        ["controller-not-started", { controllerStartedDisposition: "absent", attemptReceiptDisposition: "valid", receiptInfrastructureCategory: "launch-failed", controllerExitCode: null, controllerStdoutDisposition: "absent", resultDisposition: "invalid", resultSha256: null, stateDisposition: "invalid", stateSha256: null, id06ReceiptDisposition: "invalid", receiptSha256: null, controllerProcessDisposition: "not-applicable", childProcessDisposition: "not-applicable", cleanupResidueDispositions: ["present", "absent", "absent"] }],
        ["controller-outcome-uncertain", { attemptReceiptDisposition: "absent", receiptInfrastructureCategory: null, controllerExitCode: null, resultDisposition: "invalid", cleanupResidueDispositions: ["present", "absent", "absent"] }],
        ["controller-capture-invalid", { receiptInfrastructureCategory: "capture-invalid", controllerStdoutDisposition: "invalid", resultDisposition: "invalid", stateDisposition: "invalid" }],
        ["controller-result-invalid", { resultDisposition: "invalid", stateDisposition: "invalid", id06ReceiptDisposition: "invalid" }],
        ["controller-state-invalid", { stateDisposition: "invalid", id06ReceiptDisposition: "invalid", childProcessDisposition: "present" }],
        ["controller-receipt-invalid", { id06ReceiptDisposition: "invalid", childProcessDisposition: "present", sourceStableIdentityValid: false }],
        ["child-settlement-invalid", { childProcessDisposition: "present", sourceStableIdentityValid: false, cleanupResidueDispositions: ["present", "absent", "absent"] }],
        ["out-restoration-invalid", { sourceStableIdentityValid: false, cleanupResidueDispositions: ["present", "absent", "absent"], bindingsDisposition: "invalid" }],
        ["cleanup-invalid", { cleanupResidueDispositions: ["present", "absent", "absent"], bindingsDisposition: "invalid" }, { git: dirtyBranch }],
        ["repository-invalid", { bindingsDisposition: "invalid", infrastructureValid: false }, { git: dirtyBranch }],
        ["binding-invalid", { bindingsDisposition: "invalid", infrastructureValid: false }],
      ];
      for (const [category, overrides, options] of cases) {
        expect((await runTask6Audit(fixture, { ...task6SuccessEvidence(), ...overrides }, options)).result.category).toBe(category);
      }
    } finally { await disposeFixture(fixture); }
  }, 90_000);

  it("fails closed for active, reused, indeterminate, restoration, residue, Git, and binding observations", async () => {
    const fixture = await createFixture();
    try {
      for (const value of ["present", "indeterminate"] as const) {
        expect((await runTask6Audit(fixture, { ...task6SuccessEvidence(), jobDisposition: value })).result.category).toBe("child-settlement-invalid");
        expect((await runTask6Audit(fixture, { ...task6SuccessEvidence(), controllerProcessDisposition: value })).result.category).toBe("child-settlement-invalid");
      }
      expect((await runTask6Audit(fixture, { ...task6SuccessEvidence(), controllerProcessDisposition: "reused" })).result.category).toBe("none");
      for (const overrides of [{ sourceFinalPathValid: false }, { sourceStableIdentityValid: false }, { sourceParentIdentityValid: false }, { destinationDisposition: "present" as const }, { destinationDisposition: "indeterminate" as const }]) {
        expect((await runTask6Audit(fixture, { ...task6SuccessEvidence(), ...overrides })).result.category).toBe("out-restoration-invalid");
      }
      for (const residue of ["present", "indeterminate"] as const) expect((await runTask6Audit(fixture, { ...task6SuccessEvidence(), cleanupResidueDispositions: ["absent", residue, "absent"] })).result.category).toBe("cleanup-invalid");
      const gitDrift = [
        { root: { exitCode: 0, stderrBytes: 0, overflow: false, stdout: "C:\\wrong\n" } },
        { branch: { exitCode: 0, stderrBytes: 0, overflow: false, stdout: "feature\n" } },
        { head: { exitCode: 0, stderrBytes: 0, overflow: false, stdout: `${"f".repeat(40)}\n` } },
        { status: { exitCode: 0, stderrBytes: 0, overflow: false, stdout: " M tracked.txt\n" } },
        { head: { exitCode: 1, stderrBytes: 0, overflow: false, stdout: `${task5Commit}\n` } },
        { head: { exitCode: 0, stderrBytes: 1, overflow: false, stdout: `${task5Commit}\n` } },
        { head: { exitCode: 0, stderrBytes: 0, overflow: true, stdout: `${task5Commit}\n` } },
      ];
      for (const git of gitDrift) expect((await runTask6Audit(fixture, task6SuccessEvidence(), { git })).result).toEqual(task6Expected("repository-invalid"));
      expect((await runTask6Audit(fixture, { ...task6SuccessEvidence(), bindingsDisposition: "indeterminate" })).result.category).toBe("binding-invalid");
    } finally { await disposeFixture(fixture); }
  }, 60_000);

  it("classifies each missing evidence hash at its own stage and never projects an empty nullable hash", async () => {
    const fixture = await createFixture();
    try {
      const cases: Array<[Partial<Task6Evidence>, string, "resultSha256" | "stateSha256" | "receiptSha256"]> = [
        [{ resultSha256: null }, "controller-result-invalid", "resultSha256"],
        [{ stateSha256: null }, "controller-state-invalid", "stateSha256"],
        [{ receiptSha256: null }, "controller-receipt-invalid", "receiptSha256"],
      ];
      for (const [overrides, category, field] of cases) {
        const answer = await runTask6Audit(fixture, { ...task6SuccessEvidence(), ...overrides });
        expect(answer.result.category).toBe(category);
        expect(answer.result[field]).toBeNull();
        expect(Object.values(answer.result)).not.toContain("");
      }
    } finally { await disposeFixture(fixture); }
  });

  it("rejects impossible process applicability and contradictory supervisor-identity shapes before success", async () => {
    const fixture = await createFixture();
    try {
      const processCases: Array<Partial<Task6Evidence>> = [
        { controllerProcessDisposition: "not-applicable" }, { childProcessDisposition: "not-applicable" },
        { controllerProcessDisposition: "absent" }, { childProcessDisposition: "absent" },
      ];
      for (const overrides of processCases) {
        expect((await runTask6Audit(fixture, { ...task6SuccessEvidence(), ...overrides })).result.category)
          .toBe("child-settlement-invalid");
      }
      expect((await runTask6Audit(fixture, { ...task6SuccessEvidence(), controllerProcessDisposition: "reused", childProcessDisposition: "reused" })).result.category)
        .toBe("none");
      for (const value of ["present", "indeterminate"] as const) {
        expect((await runTask6Audit(fixture, { ...task6SuccessEvidence(), childProcessDisposition: value })).result.category)
          .toBe("child-settlement-invalid");
      }
      expect((await runTask6Audit(fixture, { ...task6SuccessEvidence(), supervisorIdentityInvalidShape: true })).result.category)
        .toBe("attempt-evidence-invalid");
    } finally { await disposeFixture(fixture); }
  }, 60_000);

  it("runs AuditOnly twice byte-identically with four exact Git reads and zero writes, starts, cleanup, or fixture mutation", async () => {
    const fixture = await createFixture();
    try {
      fixture.document.expectedCommit = task5Commit; await writeFile(fixture.paths.manifest, JSON.stringify(fixture.document), "utf8");
      const before = await snapshotFixture(fixture); const first = await runTask6Audit(fixture, task6SuccessEvidence()); const middle = await snapshotFixture(fixture);
      const second = await runTask6Audit(fixture, task6SuccessEvidence()); const after = await snapshotFixture(fixture);
      expect(first.result).toEqual(second.result); expect(first.writes).toBe(0); expect(second.writes).toBe(0);
      expect(first.controllerStarts + second.controllerStarts + first.cleanupCalls + second.cleanupCalls).toBe(0);
      expect(first.git).toEqual(["root", "branch", "head", "status"]); expect(second.git).toEqual(first.git);
      expect(middle).toEqual(before); expect(after).toEqual(before);
      const absent = await runTask6Audit(fixture, { ...task6SuccessEvidence(), attemptRootDisposition: "absent", authorizationCopyValid: false,
        consumptionDisposition: "absent", controllerStartedDisposition: "absent", attemptReceiptDisposition: "absent" });
      expect(absent.result.category).toBe("attempt-not-consumed"); expect(absent.writes).toBe(0);
    } finally { await disposeFixture(fixture); }
  });

  it("validates a stored audit only after recomputation and requires exact canonical bytes", async () => {
    const fixture = await createFixture();
    try {
      const pass = task5Audit(); const bytes = Buffer.from(JSON.stringify(pass));
      const matching = { ...task6SuccessEvidence(), storedAuditDisposition: "present" as const, storedAuditDocument: pass, storedAuditBytesBase64: bytes.toString("base64") };
      expect((await runTask6Audit(fixture, matching)).result.category).toBe("none");
      const executeMatching = await runTask6Audit(fixture, matching, { mode: "Execute" });
      expect(executeMatching.result.category).toBe("none"); expect(executeMatching.writes).toBe(0);
      const mismatch = { ...matching, storedAuditBytesBase64: Buffer.from(JSON.stringify({ ...pass, bindingsValid: false, status: "TERMINAL-NOT-PASS", category: "binding-invalid" })).toString("base64"), storedAuditDocument: { ...pass, bindingsValid: false, status: "TERMINAL-NOT-PASS", category: "binding-invalid" } };
      expect((await runTask6Audit(fixture, mismatch)).result).toEqual(task6Expected("attempt-evidence-invalid"));
      const malformedBase64 = { ...matching, storedAuditBytesBase64: "%%%not-base64%%%" };
      expect((await runTask6Audit(fixture, malformedBase64)).result).toEqual(task6Expected("attempt-evidence-invalid"));
      expect((await runTask6Audit(fixture, malformedBase64, { mode: "Execute" })).result).toEqual(task6Expected("attempt-evidence-invalid"));
      const malformedDocument = { ...matching, storedAuditDocument: { schema: "wrong" } };
      expect((await runTask6Audit(fixture, malformedDocument)).result).toEqual(task6Expected("attempt-evidence-invalid"));
      expect((await runTask6Audit(fixture, malformedDocument, { mode: "Execute" })).result).toEqual(task6Expected("attempt-evidence-invalid"));
      expect((await runTask6Audit(fixture, { ...matching, storedAuditDisposition: "invalid", storedAuditDocument: null, storedAuditBytesBase64: null })).result.category).toBe("attempt-evidence-invalid");
    } finally { await disposeFixture(fixture); }
  }, 30_000);

  it("completes all four Git observations after a thrown read and classifies every ordinal as repository-invalid", async () => {
    const fixture = await createFixture();
    try {
      for (const observation of ["root", "branch", "head", "status"] as const) {
        const answer = await runTask6Audit(fixture, task6SuccessEvidence(), { gitThrows: observation });
        expect(answer.result).toEqual(task6Expected("repository-invalid"));
        expect(answer.git).toEqual(["root", "branch", "head", "status"]);
        expect(answer.writes + answer.controllerStarts + answer.cleanupCalls).toBe(0);
      }
    } finally { await disposeFixture(fixture); }
  });

  it("uses the one declared precedence table and separates Execute writing from read-only AuditOnly", async () => {
    const fixture = await createFixture();
    try {
      const execute = await runTask6Audit(fixture, task6SuccessEvidence(), { mode: "Execute" });
      expect(execute.result).toEqual(task6Expected("none")); expect(execute.writes).toBe(1); expect(execute.written).not.toBeNull();
      expect(JSON.parse(Buffer.from(execute.written!, "base64").toString("utf8"))).toEqual(task6Expected("none"));

      const source = await readFile(scriptPath, "utf8");
      const precedenceNeedle = "'cleanup-invalid',\n    'repository-invalid'";
      const reordered = source.replace(precedenceNeedle, "'repository-invalid',\n    'cleanup-invalid'");
      expect(reordered).not.toBe(source);
      const reorderedPath = join(fixture.root, "task6-reordered-precedence.ps1"); await writeFile(reorderedPath, reordered, "utf8");
      const both = { ...task6SuccessEvidence(), cleanupResidueDispositions: ["present", "absent", "absent"] as Task6Evidence["cleanupResidueDispositions"] };
      expect((await runTask6Audit(fixture, both, { scriptPath: reorderedPath, git: { branch: { exitCode: 0, stderrBytes: 0, overflow: false, stdout: "feature\n" } } })).result.category)
        .toBe("repository-invalid");

      const coApplicableBoundaries: Array<[string, string, Partial<Task6Evidence>, Parameters<typeof runTask6Audit>[2]?]> = [
        ["attempt-not-consumed", "attempt-evidence-invalid", { attemptRootDisposition: "absent", authorizationCopyValid: false, consumptionDisposition: "invalid" }],
        ["attempt-evidence-invalid", "controller-not-started", { consumptionDisposition: "invalid", controllerStartedDisposition: "absent", attemptReceiptDisposition: "valid", receiptInfrastructureCategory: "launch-failed", controllerExitCode: null, controllerStdoutDisposition: "absent", resultDisposition: "absent", resultSha256: null, stateDisposition: "absent", stateSha256: null, id06ReceiptDisposition: "absent", receiptSha256: null, controllerProcessDisposition: "not-applicable", childProcessDisposition: "not-applicable" }],
        ["controller-capture-invalid", "controller-result-invalid", { receiptInfrastructureCategory: "capture-invalid", controllerStdoutDisposition: "invalid", resultDisposition: "invalid", resultSha256: null }],
        ["controller-result-invalid", "controller-state-invalid", { resultDisposition: "invalid", resultSha256: null, stateDisposition: "invalid", stateSha256: null }],
        ["controller-state-invalid", "controller-receipt-invalid", { stateDisposition: "invalid", stateSha256: null, id06ReceiptDisposition: "invalid", receiptSha256: null }],
        ["controller-receipt-invalid", "child-settlement-invalid", { id06ReceiptDisposition: "invalid", receiptSha256: null, childProcessDisposition: "present" }],
        ["child-settlement-invalid", "out-restoration-invalid", { childProcessDisposition: "present", sourceStableIdentityValid: false }],
        ["out-restoration-invalid", "cleanup-invalid", { sourceStableIdentityValid: false, cleanupResidueDispositions: ["present", "absent", "absent"] }],
        ["cleanup-invalid", "repository-invalid", { cleanupResidueDispositions: ["present", "absent", "absent"] }, { git: { branch: { exitCode: 0, stderrBytes: 0, overflow: false, stdout: "feature\n" } } }],
        ["repository-invalid", "binding-invalid", { bindingsDisposition: "invalid" }, { git: { branch: { exitCode: 0, stderrBytes: 0, overflow: false, stdout: "feature\n" } } }],
        ["binding-invalid", "audit-infrastructure-invalid", { bindingsDisposition: "invalid", infrastructureValid: false }],
      ];
      const precedenceStart = source.indexOf("$script:IntentArcPreflightAuditPrecedence = [string[]] @(");
      const precedenceEnd = source.indexOf("\n)", precedenceStart);
      expect(precedenceStart).toBeGreaterThanOrEqual(0); expect(precedenceEnd).toBeGreaterThan(precedenceStart);
      const precedenceSource = source.slice(precedenceStart, precedenceEnd);
      for (const [earlier, later, overrides, options] of coApplicableBoundaries) {
        const earlierToken = `'${earlier}'`; const laterToken = `'${later}'`;
        expect(precedenceSource.indexOf(earlierToken)).toBeLessThan(precedenceSource.indexOf(laterToken));
        const swappedPrecedence = precedenceSource
          .replace(earlierToken, "'__precedence_swap__'")
          .replace(laterToken, earlierToken)
          .replace("'__precedence_swap__'", laterToken);
        const mutant = source.slice(0, precedenceStart) + swappedPrecedence + source.slice(precedenceEnd);
        const mutantPath = join(fixture.root, `task6-precedence-${earlier}.ps1`); await writeFile(mutantPath, mutant, "utf8");
        const mutated = await runTask6Audit(fixture, { ...task6SuccessEvidence(), ...overrides }, { ...options, scriptPath: mutantPath });
        expect([later, "audit-infrastructure-invalid"]).toContain(mutated.result.category);
        expect(mutated.result.category).not.toBe(earlier);
        expect(mutated.valid).toBe(true);
      }

      const auditWriterMutant = source.replace("$AuthorizationContext.Invocation.mode -ceq 'Execute'", "$AuthorizationContext.Invocation.mode -cne 'Execute'");
      expect(auditWriterMutant).not.toBe(source);
      const writerPath = join(fixture.root, "task6-audit-writer.ps1"); await writeFile(writerPath, auditWriterMutant, "utf8");
      expect((await runTask6Audit(fixture, task6SuccessEvidence(), { scriptPath: writerPath })).writes).toBe(1);
    } finally { await disposeFixture(fixture); }
  }, 120_000);

  it("kills skipped restoration, accepted indeterminate, delete-sharing, path-reopen, and success-shortcut mutants", async () => {
    const fixture = await createFixture();
    try {
      const source = await readFile(scriptPath, "utf8");
      const restorationMutants: Array<[string, string, string, Partial<Task6Evidence>]> = [
        ["final", "-not $Evidence.sourceFinalPathValid -or", "$false -or", { sourceFinalPathValid: false }],
        ["stable", "-not $Evidence.sourceStableIdentityValid -or", "$false -or", { sourceStableIdentityValid: false }],
        ["parent", "-not $Evidence.sourceParentIdentityValid -or", "$false -or", { sourceParentIdentityValid: false }],
        ["destination", "$Evidence.destinationDisposition -cne 'absent'", "$false", { destinationDisposition: "indeterminate" }],
      ];
      for (const [name, check, replacement, overrides] of restorationMutants) {
        const mutant = source.replace(check, replacement); expect(mutant, name).not.toBe(source);
        const mutantPath = join(fixture.root, `task6-restoration-${name}.ps1`); await writeFile(mutantPath, mutant, "utf8");
        expect((await runTask6Audit(fixture, { ...task6SuccessEvidence(), ...overrides }, { scriptPath: mutantPath })).result.category, name).toBe("none");
      }

      const absenceMutant = source.replace("if ($disposition -cne 'absent') { $cleanupInvalid = $true }", "if ($disposition -ceq 'present') { $cleanupInvalid = $true }");
      expect(absenceMutant).not.toBe(source);
      const absencePath = join(fixture.root, "task6-indeterminate-absence.ps1"); await writeFile(absencePath, absenceMutant, "utf8");
      expect((await runTask6Audit(fixture, { ...task6SuccessEvidence(), cleanupResidueDispositions: ["indeterminate", "absent", "absent"] }, { scriptPath: absencePath })).result.category).toBe("none");

      const shareNeedle = "return new BoundaryGuard(path, expectedFinalPath, true, 0u, null, false, true, false);";
      const shareMutant = source.replace(shareNeedle, "return new BoundaryGuard(path, expectedFinalPath, true, 0u, null, false, true, true);");
      expect(shareMutant).not.toBe(source);
      const sharePath = join(fixture.root, "task6-delete-sharing.ps1"); await writeFile(sharePath, shareMutant, "utf8");
      const shareAnswer = JSON.parse(await runPowerShellScript([
        `. ${quote(sharePath)}`, "Initialize-IntentArcPreflightExecutionNative",
        `$leaf=Join-Path ${quote(fixture.root)} 'task6-audit-leaf';$moved=$leaf+'-moved';[void][IO.Directory]::CreateDirectory($leaf);$guard=[IntentArc.PreflightEnvelope.BoundaryGuard]::OpenDirectoryForAudit($leaf,$leaf)`,
        "$moveSucceeded=$false;try{[IO.Directory]::Move($leaf,$moved);$moveSucceeded=$true}catch{}finally{$guard.Dispose()}",
        "[ordered]@{moveSucceeded=$moveSucceeded}|ConvertTo-Json -Compress",
      ].join("\n"))) as { moveSucceeded: boolean };
      expect(shareAnswer.moveSucceeded).toBe(true);

      const readerStart = source.indexOf("function Read-IntentArcPreflightTerminalAuditProtectedDocument");
      const readerEnd = source.indexOf("function Read-IntentArcPreflightTerminalAuditProductionEvidence", readerStart);
      const pathReopenMutant = source.slice(0, readerStart) + source.slice(readerStart, readerEnd)
        .replace("$value = Read-IntentArcClosedJsonDocument -Guard $guard", "$bytes = [IO.File]::ReadAllBytes($path); $value = Read-IntentArcClosedJsonDocument -Guard $guard") + source.slice(readerEnd);
      expect(pathReopenMutant).not.toBe(source);
      const pathReopenPath = join(fixture.root, "task6-path-reopen.ps1"); await writeFile(pathReopenPath, pathReopenMutant, "utf8");
      expect((await task6AuditPathPolicyViolations(scriptPath)).violations).toEqual([]);
      expect((await task6AuditPathPolicyViolations(pathReopenPath)).violations).toEqual(["path-based evidence read"]);

      const shortcutNeedle = "    $allJournalAbsent = $Evidence.consumptionDisposition";
      const shortcutMutant = source.replace(shortcutNeedle, "    if ($Evidence.controllerExitCode -eq 0 -and $Evidence.resultDisposition -ceq 'candidate') { return 'none' }\n" + shortcutNeedle);
      expect(shortcutMutant).not.toBe(source);
      const shortcutPath = join(fixture.root, "task6-success-shortcut.ps1"); await writeFile(shortcutPath, shortcutMutant, "utf8");
      expect((await runTask6Audit(fixture, { ...task6SuccessEvidence(), stateDisposition: "invalid", stateSha256: null }, { scriptPath: shortcutPath })).result.category).toBe("audit-infrastructure-invalid");
    } finally { await disposeFixture(fixture); }
  }, 90_000);
});

describe.sequential("desktop release preflight once Task 5 fix round 1", () => {
  const task5TerminalAudit = (category: string, overrides: Record<string, unknown> = {}) => ({
    ...task5Audit(), status: "TERMINAL-NOT-PASS", category,
    expectedCommit: task5Commit, attemptConsumed: false, controllerStarted: false, controllerExitCode: null,
    resultSha256: null, stateSha256: null, receiptSha256: null,
    outRestored: false, cleanupComplete: false, gitClean: false, bindingsValid: false,
    ...overrides,
  });

  it("enforces the complete audit category prefix and forced suffix projection table", async () => {
    const resultSha256 = "4".repeat(64);
    const stateSha256 = "5".repeat(64);
    const receiptSha256 = "6".repeat(64);
    const prefix = { attemptConsumed: true, controllerStarted: true, controllerExitCode: 0 };
    const documents = [
      task5TerminalAudit("authorization-invalid", { expectedCommit: null }),
      task5TerminalAudit("attempt-not-consumed"),
      task5TerminalAudit("attempt-evidence-invalid"),
      task5TerminalAudit("controller-not-started", { attemptConsumed: true }),
      task5TerminalAudit("controller-outcome-uncertain", { attemptConsumed: true }),
      task5TerminalAudit("controller-outcome-uncertain", { attemptConsumed: true, controllerStarted: true }),
      task5TerminalAudit("controller-capture-invalid", { attemptConsumed: true, controllerStarted: true }),
      task5TerminalAudit("controller-capture-invalid", prefix),
      task5TerminalAudit("controller-result-invalid", prefix),
      task5TerminalAudit("controller-state-invalid", { ...prefix, resultSha256 }),
      task5TerminalAudit("controller-receipt-invalid", { ...prefix, resultSha256, stateSha256 }),
      task5TerminalAudit("child-settlement-invalid", { ...prefix, resultSha256, stateSha256, receiptSha256 }),
      task5TerminalAudit("out-restoration-invalid", { ...prefix, resultSha256, stateSha256, receiptSha256 }),
      task5TerminalAudit("cleanup-invalid", { ...prefix, resultSha256, stateSha256, receiptSha256, outRestored: true }),
      task5TerminalAudit("repository-invalid", { ...prefix, resultSha256, stateSha256, receiptSha256, outRestored: true, cleanupComplete: true }),
      task5TerminalAudit("binding-invalid", { ...prefix, resultSha256, stateSha256, receiptSha256, outRestored: true, cleanupComplete: true, gitClean: true }),
      task5TerminalAudit("audit-infrastructure-invalid", { expectedCommit: null }),
      task5TerminalAudit("audit-infrastructure-invalid"),
    ];
    expect(await runTask5ValidationMatrix(documents, "Test-IntentArcPreflightAuditResult -Document $document"))
      .toEqual(documents.map(() => true));

    const contradictory = [
      task5TerminalAudit("authorization-invalid", { attemptConsumed: true }),
      task5TerminalAudit("attempt-not-consumed", { controllerStarted: true }),
      task5TerminalAudit("attempt-evidence-invalid", { controllerExitCode: 0 }),
      task5TerminalAudit("controller-not-started", { attemptConsumed: true, controllerStarted: true }),
      task5TerminalAudit("controller-outcome-uncertain", { attemptConsumed: true, resultSha256 }),
      task5TerminalAudit("controller-capture-invalid", { ...prefix, resultSha256 }),
      task5TerminalAudit("controller-result-invalid", { ...prefix, resultSha256 }),
      task5TerminalAudit("controller-state-invalid", { ...prefix, resultSha256, stateSha256 }),
      task5TerminalAudit("controller-state-invalid", { ...prefix, controllerExitCode: 7, resultSha256 }),
      task5TerminalAudit("controller-receipt-invalid", { ...prefix, resultSha256, stateSha256, receiptSha256 }),
      task5TerminalAudit("child-settlement-invalid", { ...prefix, controllerExitCode: 7, resultSha256, stateSha256, receiptSha256 }),
      task5TerminalAudit("child-settlement-invalid", { ...prefix, resultSha256, stateSha256, receiptSha256, outRestored: true }),
      task5TerminalAudit("out-restoration-invalid", { ...prefix, resultSha256, stateSha256, receiptSha256, cleanupComplete: true }),
      task5TerminalAudit("cleanup-invalid", { ...prefix, resultSha256, stateSha256, receiptSha256, outRestored: true, gitClean: true }),
      task5TerminalAudit("repository-invalid", { ...prefix, resultSha256, stateSha256, receiptSha256, outRestored: true, cleanupComplete: true, bindingsValid: true }),
      task5TerminalAudit("binding-invalid", { ...prefix, resultSha256, stateSha256, receiptSha256, outRestored: true, cleanupComplete: true, gitClean: true, bindingsValid: true }),
      task5TerminalAudit("audit-infrastructure-invalid", { expectedCommit: null, receiptSha256 }),
    ];
    expect(await runTask5ValidationMatrix(contradictory, "Test-IntentArcPreflightAuditResult -Document $document"))
      .toEqual(contradictory.map(() => false));
  });

  it("accepts capture and exit in either order while rejecting the required launch, start, capture, exit, and record reversals", async () => {
    const captureBeforeExit = {
      ...task5AttemptReceipt(), controllerStartTimeUtc: task5Timestamp(1), controllerStartedAtUtc: task5Timestamp(2),
      captureCompletedAtUtc: task5Timestamp(3), controllerExitedAtUtc: task5Timestamp(4), recordedAtUtc: task5Timestamp(5),
    };
    const exitBeforeCapture = {
      ...captureBeforeExit, controllerExitedAtUtc: task5Timestamp(1), captureCompletedAtUtc: task5Timestamp(3),
    };
    const cases = [captureBeforeExit, exitBeforeCapture,
      { ...captureBeforeExit, launchAttemptedAtUtc: task5Timestamp(2) },
      { ...captureBeforeExit, controllerStartTimeUtc: task5Timestamp(3) },
      { ...captureBeforeExit, captureCompletedAtUtc: task5Timestamp(1) },
      { ...captureBeforeExit, controllerExitedAtUtc: task5Timestamp(0) },
      { ...captureBeforeExit, recordedAtUtc: task5Timestamp(3) }];
    expect(await runTask5ValidationMatrix(cases, "Test-IntentArcPreflightAttemptReceipt -Document $document"))
      .toEqual([true, true, false, false, false, false, false]);
  });

  it("closes the state-evidence-invalid result outcome matrix without a permissive category fallback", async () => {
    const row = (overrides: Record<string, unknown>) => ({
      ...task5Result(), status: "FAIL", category: "state-evidence-invalid", cleanupCategory: "none",
      phase: "validated", childStarted: false, childExitCode: null, outRestored: false, ...overrides,
    });
    const valid = [
      row({}), row({ phase: "prepared" }), row({ phase: "prepared", outRestored: true }),
      row({ phase: "preserved" }), row({ phase: "preserved", outRestored: true }),
      row({ phase: "child-started" }), row({ phase: "child-started", outRestored: true }),
      row({ phase: "child-started", childStarted: true, childExitCode: 7, outRestored: true }),
      row({ phase: "child-settled" }),
      row({ phase: "child-settled", childStarted: true, childExitCode: 0, outRestored: true }),
      row({ phase: "child-settled", outRestored: true }),
      row({ phase: "restored", childStarted: true, childExitCode: -2147483648, outRestored: true }),
      row({ phase: "restored", outRestored: true }),
      row({ phase: "restored", outRestored: true, cleanupCategory: "residue-invalid" }),
    ];
    expect(await runTask5ValidationMatrix(valid, "Test-IntentArcId06ResultV2 -Document $document"))
      .toEqual(valid.map(() => true));
    const invalid = [
      row({ status: "PASS" }), row({ phase: "complete", outRestored: true }), row({ outRestored: true }),
      row({ phase: "validated", childStarted: true }), row({ phase: "prepared", childExitCode: 0 }),
      row({ phase: "child-started", childStarted: true }),
      row({ phase: "child-settled", childStarted: true, childExitCode: 0 }),
      row({ phase: "restored", outRestored: false }), row({ childStarted: false, childExitCode: 0 }),
      row({ cleanupCategory: "residue-invalid" }),
      row({ phase: "child-settled", outRestored: true, cleanupCategory: "residue-invalid" }),
    ];
    expect(await runTask5ValidationMatrix(invalid, "Test-IntentArcId06ResultV2 -Document $document"))
      .toEqual(invalid.map(() => false));
  });

  it("enforces the output cap flag at the threshold and threshold plus one for both state streams and candidate success", async () => {
    const exactStdout = task5State("complete", { stdoutBytes: 1048576 });
    const exactStderr = task5State("complete", { stderrBytes: 1048576 });
    const overflowStdout = task5State("complete", { stdoutBytes: 1048577 });
    const overflowStderr = task5State("complete", { stderrBytes: 1048577 });
    const stateCases = [exactStdout, exactStderr, overflowStdout, overflowStderr,
      task5State("child-settled", { terminationReason: "output-overflow", exitCode: null, stdoutBytes: 1048577, outputOverflow: true }),
      task5State("child-settled", { terminationReason: "output-overflow", exitCode: null, stderrBytes: 1048577, outputOverflow: true }),
      task5State("child-settled", { terminationReason: "output-overflow", exitCode: null, stdoutBytes: 1048576, outputOverflow: true }),
      task5State("child-settled", { terminationReason: "output-overflow", exitCode: null, stderrBytes: 1048576, outputOverflow: true }),
    ];
    expect(await runTask5ValidationMatrix(stateCases, task5StateInvocation))
      .toEqual([true, true, false, false, true, true, false, false]);

    const candidateInvocation = `Test-IntentArcId06CandidateSuccess -Result $document.result -State $document.state -Receipt $document.receipt -ExpectedCommit '${task5Commit}' -PnpmPath '${task5Paths.pnpm}' -PnpmSha256 '${task5PnpmSha256}' -SourcePath '${task5Paths.source}' -DestinationPath '${task5Paths.destination}' -ProfilePath '${task5Paths.profile}' -LocalAppDataPath '${task5Paths.localAppData}'`;
    const candidates = [exactStdout, exactStderr, overflowStdout, overflowStderr]
      .map((state) => ({ result: task5Result(), state, receipt: task5Receipt() }));
    expect(await runTask5ValidationMatrix(candidates, candidateInvocation)).toEqual([true, true, false, false]);
  });

  it("accepts exactly the cap and rejects cap plus one for every closed document dispatch row", async () => {
    const consumption = {
      schema: "intentarc.preflight-execution-consumed/v1", attemptId: "phase1-preflight-envelope-20260902-01",
      authorizationSha256: task5AuthorizationSha256, consumedAtUtc: task5Timestamp(0), controllerLaunchStatus: "attempted",
    };
    const rows = [
      ["consumption", 16384, consumption], ["controllerStarted", 16384, task5ControllerStarted()],
      ["attemptReceipt", 32768, task5AttemptReceipt()], ["id06Result", 65536, task5Result()],
      ["id06State", 65536, task5State()], ["id06Receipt", 262144, task5Receipt()],
      ["auditResult", 16384, task5Audit()],
    ] as const;
    const cases = rows.flatMap(([schema, maximum, document]) => {
      const json = Buffer.from(JSON.stringify(document), "utf8");
      const exact = Buffer.concat([json, Buffer.alloc(maximum - json.length, 0x20)]);
      return [{ schema, maximum, bytes: exact.toString("base64") },
        { schema, maximum, bytes: Buffer.concat([exact, Buffer.from(" ")]).toString("base64") }];
    });
    const fixture = await createFixture();
    try {
      const result = JSON.parse(await runPowerShellScript([
        `. ${quote(scriptPath)}`, `$cases=${task5PowerShellJson(cases)}`, "Initialize-IntentArcPreflightExecutionNative",
        `$root=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::CreateExclusiveRoot(${quote(fixture.root)},'all-caps');$answers=@();$index=0`,
        "try{foreach($case in @($cases)){$guard=$null;try{$guard=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::WriteAtomicNew($root,('case-'+$index+'.json'),[Convert]::FromBase64String([string]$case.bytes));[void](Read-IntentArcClosedJsonDocument -Guard $guard -MaximumBytes ([int]$case.maximum) -Schema ([string]$case.schema));$answers+=,$true}catch{$answers+=,$false}finally{if($null-ne$guard){$guard.Dispose()};$index++}}}finally{$root.Dispose()}",
        "@($answers)|ConvertTo-Json -Compress",
      ].join("\n"))) as boolean[];
      expect(result).toEqual(rows.flatMap(() => [true, false]));
    } finally { await disposeFixture(fixture); }
  });

  it("exhaustively rejects missing, extra, and wrong top-level types for all seven closed schemas including controller-started", async () => {
    const consumption = {
      schema: "intentarc.preflight-execution-consumed/v1", attemptId: "phase1-preflight-envelope-20260902-01",
      authorizationSha256: task5AuthorizationSha256, consumedAtUtc: task5Timestamp(0), controllerLaunchStatus: "attempted",
    };
    const validators: Array<[Record<string, unknown>, string]> = [
      [consumption, `Test-IntentArcPreflightConsumption -Document $document -AuthorizationSha256 '${task5AuthorizationSha256}'`],
      [task5ControllerStarted(), `Test-IntentArcPreflightControllerStarted -Document $document -AuthorizationSha256 '${task5AuthorizationSha256}' -ConsumedSha256 '${task5ConsumptionSha256}'`],
      [task5AttemptReceipt(), "Test-IntentArcPreflightAttemptReceipt -Document $document"],
      [task5Result(), "Test-IntentArcId06ResultV2 -Document $document"], [task5State(), task5StateInvocation],
      [task5Receipt(), "Test-IntentArcId06Receipt -Document $document"],
      [task5Audit(), "Test-IntentArcPreflightAuditResult -Document $document"],
    ];
    for (const [document, invocation] of validators) {
      const missing = Object.keys(document).map((omitted) => Object.fromEntries(Object.entries(document).filter(([key]) => key !== omitted)));
      const wrongTypes = Object.keys(document).map((key) => ({ ...document, [key]: [] }));
      const cases = [...missing, { ...document, unexpected: true }, ...wrongTypes, [], null, "coerced"];
      expect(await runTask5ValidationMatrix(cases, invocation)).toEqual(cases.map(() => false));
    }
  }, 120_000);

  it("kills every closed size-table cap and both exact-key enforcement families", async () => {
    const source = await readFile(scriptPath, "utf8");
    const table = "$maximumBytesByDocument=[ordered]@{consumption=16384;controllerStarted=16384;attemptReceipt=32768;id06Result=65536;id06State=65536;id06Receipt=262144;auditResult=16384}";
    const documents: Record<string, Record<string, unknown>> = {
      consumption: { schema: "intentarc.preflight-execution-consumed/v1", attemptId: "phase1-preflight-envelope-20260902-01", authorizationSha256: task5AuthorizationSha256, consumedAtUtc: task5Timestamp(0), controllerLaunchStatus: "attempted" },
      controllerStarted: task5ControllerStarted(), attemptReceipt: task5AttemptReceipt(), id06Result: task5Result(),
      id06State: task5State(), id06Receipt: task5Receipt(), auditResult: task5Audit(),
    };
    const caps: Record<string, number> = { consumption: 16384, controllerStarted: 16384, attemptReceipt: 32768,
      id06Result: 65536, id06State: 65536, id06Receipt: 262144, auditResult: 16384 };
    const fixture = await createFixture();
    try {
      expect(source).toContain(table);
      for (const [schema, maximum] of Object.entries(caps)) {
        const changed = table.replace(`${schema}=${maximum}`, `${schema}=${maximum + 1}`);
        const mutant = source.replace(table, changed);
        expect(mutant, `${schema} cap mutant must alter source`).not.toBe(source);
        const mutantPath = join(fixture.root, `task5-cap-${schema}.ps1`);
        await writeFile(mutantPath, mutant, "utf8");
        const json = Buffer.from(JSON.stringify(documents[schema]), "utf8");
        const bytes = Buffer.concat([json, Buffer.alloc(maximum + 1 - json.length, 0x20)]).toString("base64");
        const accepted = JSON.parse(await runPowerShellScript([
          `. ${quote(mutantPath)}`, "Initialize-IntentArcPreflightExecutionNative",
          `$root=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::CreateExclusiveRoot(${quote(fixture.root)},${quote(`cap-${schema}`)});$guard=$null`,
          `try{$guard=[IntentArc.PreflightEnvelope.ProtectedEvidenceStore]::WriteAtomicNew($root,'case.json',[Convert]::FromBase64String('${bytes}'));$accepted=try{[void](Read-IntentArcClosedJsonDocument -Guard $guard -MaximumBytes ${maximum + 1} -Schema '${schema}');$true}catch{$false};$accepted|ConvertTo-Json -Compress}finally{if($null-ne$guard){$guard.Dispose()};$root.Dispose()}`,
        ].join("\n"))) as boolean;
        expect(accepted, `${schema} widened cap must be observable`).toBe(true);
      }

      const insertOverride = (body: string) => source.replace("\nif (-not $script:IntentArcPreflightEnvelopeWasDotSourced) {",
        `\n${body}\nif (-not $script:IntentArcPreflightEnvelopeWasDotSourced) {`);
      const exactMutantPath = join(fixture.root, "task5-exact-keys.ps1");
      await writeFile(exactMutantPath, insertOverride("function Test-IntentArcPreflightExecutionExactPropertyNames { param($Value,[string[]]$Expected) return $true }"), "utf8");
      const exactDocuments = [documents.consumption, documents.controllerStarted, documents.id06Result, documents.id06State, documents.id06Receipt]
        .map((document) => ({ ...document, unexpected: true }));
      const exactInvocations = [
        `Test-IntentArcPreflightConsumption -Document $document -AuthorizationSha256 '${task5AuthorizationSha256}'`,
        `Test-IntentArcPreflightControllerStarted -Document $document -AuthorizationSha256 '${task5AuthorizationSha256}' -ConsumedSha256 '${task5ConsumptionSha256}'`,
        "Test-IntentArcId06ResultV2 -Document $document", task5StateInvocation, "Test-IntentArcId06Receipt -Document $document",
      ];
      for (let index = 0; index < exactDocuments.length; index++) {
        expect(await runTask5ValidationMatrix([exactDocuments[index]], exactInvocations[index], exactMutantPath), `exact key mutant ${index}`).toBe(true);
      }
      const orderedMutantPath = join(fixture.root, "task5-ordered-keys.ps1");
      await writeFile(orderedMutantPath, insertOverride("function Test-IntentArcPreflightEnvelopeOrderedPropertyNames { param($Value,[string[]]$Expected) return $true }"), "utf8");
      expect(await runTask5ValidationMatrix([{ ...documents.attemptReceipt, unexpected: true }], "Test-IntentArcPreflightAttemptReceipt -Document $document", orderedMutantPath)).toBe(true);
      expect(await runTask5ValidationMatrix([{ ...documents.auditResult, unexpected: true }], "Test-IntentArcPreflightAuditResult -Document $document", orderedMutantPath)).toBe(true);
    } finally { await disposeFixture(fixture); }
  }, 180_000);
});
