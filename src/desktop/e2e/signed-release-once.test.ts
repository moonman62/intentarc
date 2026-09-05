import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = join(process.cwd(), "scripts", "signed-release-once-manifest.ps1");
const residueScriptPath = join(process.cwd(), "scripts", "signed-release-once-residue.ps1");
const controllerScriptPath = join(process.cwd(), "scripts", "signed-release-once.ps1");
const commandLineProbeScriptPath = join(process.cwd(), "scripts", "windows-commandline-probe.ps1");
const artifactParentReadinessScriptPath = join(process.cwd(), "scripts", "signed-release-artifact-parent-readiness.ps1");
const runtimeClosureHelperScriptPath = join(process.cwd(), "scripts", "release-runtime-closure.mjs");
const windowsOnly = process.platform === "win32" ? describe : describe.skip;
const temporaryRoots: string[] = [];
const fixedPowerShellExecutable = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const runId = "intentarc-phase1-signed-20260830-03";
const runDirectoryParts = [
  ".superpowers", "sdd",
  "2026-08-31-signed-release-artifact-parent-recovery",
  "signed-live-20260830-03",
] as const;
const runDirectory = join(...runDirectoryParts);
const certificateSubject = `CN=IntentArc Phase 1 ${runId}`;
const keyContainerName = `IntentArc.Release.${runId}`;

type Manifest = {
  schema: string;
  run: { id: string; maximumAttempts: number; retryCount: number };
  repository: {
    root: string;
    commit: string;
    requiredCleanTrackedWorktree: boolean;
    gitExecutablePath: string;
    gitExecutableSha256: string;
  };
  files: Array<{ path: string; sha256: string }>;
  certificate: {
    subject: string;
    keyContainerName: string;
    myStore: string;
    trustStores: string[];
    rsaBits: number;
    keySpec: string;
    provider: string;
    hashAlgorithm: string;
  };
  paths: {
    pfx: string;
    cer: string;
    runtime: string;
    consumedMarker: string;
    receipt: string;
    artifactRoot: string;
  };
  release: {
    command: string[];
    executablePath: string;
    executableSha256: string;
    verifierExecutablePath: string;
    verifierExecutableSha256: string;
    verifierScriptPath: string;
    verifierScriptSha256: string;
    signToolPath: string;
    signToolSha256: string;
    runtimeClosureSha256: string;
    runtimeClosureFileCount: number;
    runtimeClosureTotalBytes: number;
    maximumReleaseInvocations: number;
    maximumNestedMakeInvocations: number;
    bridgeAuthorizedPredecessor: string;
    externalPublicationCount: number;
    forbiddenLifecycleCount: number;
  };
  authorization: { workingDirectory: string; commandTemplate: string };
};

type Fixture = {
  manifestPath: string;
  expectedSha256: string;
  actualInvocation: string;
  manifest: Manifest;
  writeJson: (value: string) => Promise<void>;
  writeBytes: (value: Uint8Array) => Promise<void>;
};

const encodePowerShell = (source: string) =>
  Buffer.from(source, "utf16le").toString("base64");

const escapePowerShell = (value: string) => value.replaceAll("'", "''");

const runResidue = async (source: string) => {
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    `. '${escapePowerShell(residueScriptPath)}'`,
    source,
  ].join("\r\n");
  const result = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(command)],
    {
      encoding: "utf8",
      env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR },
      maxBuffer: 32 * 1024,
      timeout: 30_000,
      windowsHide: true,
    },
  );
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout);
};

type ControllerOptions = {
  repositoryClean?: boolean;
  repositoryCommit?: string;
  fileHash?: string;
  trackedFiles?: string[];
  runtimeClosureOverrides?: Partial<{ sha256: string; fileCount: number; totalBytes: number }>;
  executionBindingOverrides?: Partial<{
    releaseExecutablePath: string;
    releaseExecutableSha256: string;
    verifierExecutablePath: string;
    verifierExecutableSha256: string;
    verifierScriptPath: string;
    verifierScriptSha256: string;
    artifactParentReady: boolean;
    packageBinReady: boolean;
  }>;
  beforeOverrides?: Partial<Record<
    | "consumedMarker"
    | "myCertificate"
    | "rootTrust"
    | "trustedPublisherTrust"
    | "cngKey"
    | "pfx"
    | "cer"
    | "runtime"
    | "artifactRoot"
    | "signingEnvironment",
    number
  >>;
  outputProjectionValid?: boolean;
  outputProjectionThrows?: boolean;
  markerCreated?: boolean;
  releaseResultSource?: string;
  bundleResultSource?: string;
  releaseCreatesPartialAudit?: boolean;
  failedStages?: string[];
  residueOverrides?: Partial<Record<ResidueKey, number>>;
  realOutputEffects?: boolean;
  captureArguments?: boolean;
  stopMode?: "interruption" | "timeout" | "deadline";
  cancellationAfterPublication?: boolean;
};

type ResidueKey =
  | "myCertificate"
  | "rootTrust"
  | "trustedPublisherTrust"
  | "cngKey"
  | "pfx"
  | "cer"
  | "runtime"
  | "process"
  | "signingEnvironment"
  | "generatedDist"
  | "generatedOut"
  | "recoveryDirectory";

const emptyResidue: Record<ResidueKey, number> = {
  myCertificate: 0,
  rootTrust: 0,
  trustedPublisherTrust: 0,
  cngKey: 0,
  pfx: 0,
  cer: 0,
  runtime: 0,
  process: 0,
  signingEnvironment: 0,
  generatedDist: 0,
  generatedOut: 0,
  recoveryDirectory: 0,
};

const receiptKeys = [
  "schema",
  "runId",
  "commit",
  "manifestSha256",
  "status",
  "highestCompletedState",
  "primaryCategory",
  "cleanupCategories",
  "releaseInvocationCount",
  "nestedMakeInvocationCount",
  "forbiddenLifecycleInvocationCount",
  "externalPublicationInvocationCount",
  "bridgeDiagnosticInvocationCount",
  "residue",
  "artifactManifestSha256",
  "startedAtUtc",
  "completedAtUtc",
] as const;

const validReceipt = (): Record<string, unknown> => ({
  schema: "intentarc.signed-release-receipt/v3",
  runId,
  commit: "a".repeat(40),
  manifestSha256: "b".repeat(64),
  status: "PASS",
  highestCompletedState: "cleaned",
  primaryCategory: "none",
  cleanupCategories: [],
  releaseInvocationCount: 1,
  nestedMakeInvocationCount: 1,
  forbiddenLifecycleInvocationCount: 0,
  externalPublicationInvocationCount: 0,
  bridgeDiagnosticInvocationCount: 5,
  residue: { ...emptyResidue },
  artifactManifestSha256: "d".repeat(64),
  startedAtUtc: "2026-08-30T00:00:00.0000000Z",
  completedAtUtc: "2026-08-30T00:00:01.0000000Z",
});

const expectExactReceiptContract = (receipt: Record<string, unknown>) => {
  expect(Object.keys(receipt)).toEqual(receiptKeys);
  expect(receipt.schema).toBe("intentarc.signed-release-receipt/v3");
  for (const key of ["runId", "commit", "manifestSha256", "status", "highestCompletedState", "primaryCategory", "artifactManifestSha256", "startedAtUtc", "completedAtUtc"] as const) {
    expect(typeof receipt[key], key).toBe("string");
  }
  expect(Array.isArray(receipt.cleanupCategories)).toBe(true);
  expect((receipt.cleanupCategories as unknown[]).every((value) => typeof value === "string")).toBe(true);
  for (const key of ["releaseInvocationCount", "nestedMakeInvocationCount", "forbiddenLifecycleInvocationCount", "externalPublicationInvocationCount", "bridgeDiagnosticInvocationCount"] as const) {
    expect(Number.isInteger(receipt[key]), key).toBe(true);
  }
  expect(receipt.residue).toEqual(expect.objectContaining(emptyResidue));
  expect(Object.keys(receipt.residue as Record<string, unknown>)).toEqual(Object.keys(emptyResidue));
  expect(Object.values(receipt.residue as Record<string, unknown>).every(Number.isInteger)).toBe(true);
};

const controllerMutations = [
  "CreateConsumedMarkerAtomic",
  "PreserveOutputRoot",
  "PrepareCertificate",
  "AddTrust",
  "SetSigningEnvironment",
  "InvokeRelease",
  "PublishClosedArtifactBundle",
  "ClearSigningEnvironment",
  "RemoveTrust",
  "RemoveCertificate",
  "RemoveCngKey",
  "RemoveExactFile",
  "RemoveRuntime",
  "RemovePartialArtifactBundle",
  "RemoveGeneratedOutput",
  "RestoreOutputRoot",
  "WriteReceiptAtomic",
];

const controllerOperationNames = [
  "GetRepositoryState",
  "GetFileHash",
  "BindExecutionInputs",
  "GetTrackedFileInventory",
  "GetRuntimeClosure",
  "GetBeforeProjection",
  "CreateConsumedMarkerAtomic",
  "PreserveOutputRoot",
  "PrepareCertificate",
  "AddTrust",
  "VerifyTrust",
  "SetSigningEnvironment",
  "InvokeRelease",
  "VerifyRelease",
  "PublishClosedArtifactBundle",
  "SettleDescendants",
  "ClearSigningEnvironment",
  "RemoveTrust",
  "RemoveCertificate",
  "RemoveCngKey",
  "RemoveExactFile",
  "RemoveRuntime",
  "RemovePartialArtifactBundle",
  "RemoveGeneratedOutput",
  "RestoreOutputRoot",
  "GetAfterProjection",
  "WriteReceiptAtomic",
] as const;

const runControllerPowerShell = async (body: string) => {
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    `. '${escapePowerShell(controllerScriptPath)}'`,
    body,
  ].join("\r\n");
  const result = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(command)],
    {
      encoding: "utf8",
      env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR },
      maxBuffer: 64 * 1024,
      timeout: 30_000,
      windowsHide: true,
    },
  );
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout);
};

const testControllerInvocation = async (
  commandTemplate: string,
  actualInvocation: string,
) => runControllerPowerShell([
  `$manifest = [pscustomobject]@{ authorization = [pscustomobject]@{ commandTemplate = '${escapePowerShell(commandTemplate)}' } }`,
  `Test-IntentArcSignedReleaseInvocation -Manifest $manifest -ActualInvocation '${escapePowerShell(actualInvocation)}' | ConvertTo-Json -Compress`,
].join("\r\n")) as Promise<boolean>;

const runReceiptWriter = async (receiptPath: string, receipt: Record<string, unknown>) => runControllerPowerShell([
  `$receipt = '${escapePowerShell(JSON.stringify(receipt))}' | ConvertFrom-Json`,
  `$outcome = try { Write-IntentArcSignedReleaseReceiptAtomic -LiteralPath '${escapePowerShell(receiptPath)}' -Receipt $receipt -ExpectedRunId '${runId}'; 'accepted' } catch { $_.Exception.Message }`,
  "$outcome | ConvertTo-Json -Compress",
].join("\r\n"));

const runProductionReceiptWriter = async (
  receiptPath: string,
  receipt: Record<string, unknown>,
  expectedRunId = runId,
) => runControllerPowerShell([
  "$operations = New-IntentArcSignedReleaseOperations",
  "$state = $operations['WriteReceiptAtomic'].Module.SessionState.PSVariable.GetValue('state')",
  `$state.Manifest = [pscustomobject]@{ run = [pscustomobject]@{ id = '${escapePowerShell(expectedRunId)}' } }`,
  `$receipt = '${escapePowerShell(JSON.stringify(receipt))}' | ConvertFrom-Json`,
  `$outcome = try { & $operations['WriteReceiptAtomic'] '${escapePowerShell(receiptPath)}' $receipt; 'accepted' } catch { $_.Exception.Message }`,
  "$outcome | ConvertTo-Json -Compress",
].join("\r\n"));

const inspectProductionDefaults = async () =>
  runControllerPowerShell([
    "$script:mutationCount = 0",
    "function global:Start-Process { $script:mutationCount++; throw 'mutation' }",
    "function global:New-SelfSignedCertificate { $script:mutationCount++; throw 'mutation' }",
    "function global:Export-PfxCertificate { $script:mutationCount++; throw 'mutation' }",
    "function global:Export-Certificate { $script:mutationCount++; throw 'mutation' }",
    "function global:Import-Certificate { $script:mutationCount++; throw 'mutation' }",
    "function global:Import-PfxCertificate { $script:mutationCount++; throw 'mutation' }",
    "function global:Remove-Item { $script:mutationCount++; throw 'mutation' }",
    "function global:Get-Command { $script:mutationCount++; throw 'mutation' }",
    "$operations = New-IntentArcSignedReleaseOperations",
    "$metadata = foreach ($name in Get-IntentArcSignedReleaseOperationNames) { $operations[$name].IntentArcMetadata }",
    "[ordered]@{ mutations = $script:mutationCount; names = @(Get-IntentArcSignedReleaseOperationNames); metadata = @($metadata) } | ConvertTo-Json -Depth 8 -Compress",
  ].join("\r\n"));

const evaluateControllerSourcePolicy = async (source: string) => {
  const root = await mkdtemp(join(tmpdir(), "intentarc-controller-policy-"));
  temporaryRoots.push(root);
  const candidatePath = join(root, "candidate.ps1");
  await writeFile(candidatePath, source, "utf8");
  return runControllerPowerShell([
    `$source = [IO.File]::ReadAllText('${escapePowerShell(candidatePath)}')`,
    "Test-IntentArcSignedReleaseSourcePolicy -Source $source | ConvertTo-Json -Depth 6 -Compress",
  ].join("\r\n"));
};

windowsOnly("windows command-line probe", () => {
  it("reproduces the reviewed outer and quote-only executable command-line digests", () => {
    // Break caught: changing either the reviewed transport bytes or the sole
    // accepted Windows launch derivation would bind authorization to the wrong
    // raw process command line.
    const outer = `${fixedPowerShellExecutable} -NoProfile -NonInteractive -File "C:\\projects\\Project Manager\\scripts\\windows-commandline-probe.ps1"`;
    const quoteOnlyExecutable = `"${fixedPowerShellExecutable}"${outer.slice(fixedPowerShellExecutable.length)}`;

    expect(Buffer.byteLength(outer, "utf8")).toBe(158);
    expect(createHash("sha256").update(outer, "utf8").digest("hex")).toBe(
      "95b2c26cbf90c260ce77a98dd93476cb24241b19f2a4cc7e2e11fdbcedfcd8e7",
    );
    expect(Buffer.byteLength(quoteOnlyExecutable, "utf8")).toBe(160);
    expect(createHash("sha256").update(quoteOnlyExecutable, "utf8").digest("hex")).toBe(
      "2a6ff330c33497e03b91b391f8e0bce4276b26c16e232ce8fc74411e484b91da",
    );
  });

  it("emits only the exact JSON schema and accurate UTF-8 command-line hash", async () => {
    // Break caught: exposing the command line or hashing a different encoding
    // would turn this inert diagnostic probe into a secret-bearing channel.
    const command = [
      "$ErrorActionPreference = 'Stop'",
      `. '${escapePowerShell(commandLineProbeScriptPath)}'`,
      "$encoding = [Text.UTF8Encoding]::new($false, $true)",
      "$algorithm = [Security.Cryptography.SHA256]::Create()",
      "try { $expected = ([BitConverter]::ToString($algorithm.ComputeHash($encoding.GetBytes([Environment]::CommandLine)))).Replace('-', '').ToLowerInvariant(); $actual = Get-IntentArcWindowsCommandLineProbe } finally { $algorithm.Dispose() }",
      "[ordered]@{ expected = $expected; actual = $actual } | ConvertTo-Json -Compress",
    ].join("\r\n");
    const result = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-File", commandLineProbeScriptPath],
      { encoding: "utf8", env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } },
    );
    const direct = JSON.parse(result.stdout);
    const inspected = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(command)],
      { encoding: "utf8", env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } },
    );
    const value = JSON.parse(inspected.stdout);

    expect(result.stderr).toBe("");
    expect(Object.keys(direct).sort()).toEqual(["commandLineSha256", "schema"]);
    expect(direct).toEqual({ schema: "intentarc.windows-commandline-probe/v1", commandLineSha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(value.actual).toEqual({ schema: "intentarc.windows-commandline-probe/v1", commandLineSha256: value.expected });
  });

  it("refuses arguments and remains dormant when dot-sourced", async () => {
    // Break caught: an argument-bearing or importing caller must not obtain
    // a side effect or an unbounded command-line disclosure.
    const refused = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-File", commandLineProbeScriptPath, "unexpected"],
      { encoding: "utf8", env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } },
    ).catch((error: { code?: number; stdout?: string; stderr?: string }) => error);
    const dormant = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(`. '${escapePowerShell(commandLineProbeScriptPath)}'\r\n'dormant'`)],
      { encoding: "utf8", env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } },
    );

    expect(refused).toMatchObject({ code: 1, stdout: "", stderr: "commandline-probe-invalid\n" });
    expect(dormant).toMatchObject({ stdout: "dormant\r\n", stderr: "" });
  });

  it.each([
    ["Verbose", ["-Verbose"]],
    ["Debug", ["-Debug"]],
    ["ErrorAction", ["-ErrorAction", "SilentlyContinue"]],
  ])("refuses the PowerShell -%s common parameter", async (_name, args) => {
    // Break caught: advanced script binding can consume a common parameter
    // before the probe's closed no-argument check sees it.
    const refused = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-File", commandLineProbeScriptPath, ...args],
      { encoding: "utf8", env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } },
    ).catch((error: { code?: number; stdout?: string; stderr?: string }) => error);

    expect(refused).toMatchObject({ code: 1, stdout: "", stderr: "commandline-probe-invalid\n" });
  });
});

const runController = async (fixture: Fixture, options: ControllerOptions = {}) => {
  const before = {
    consumedMarker: 0,
    myCertificate: 0,
    rootTrust: 0,
    trustedPublisherTrust: 0,
    cngKey: 0,
    pfx: 0,
    cer: 0,
    runtime: 0,
    artifactRoot: 0,
    signingEnvironment: 0,
    ...options.beforeOverrides,
  };
  const beforeEntries = Object.entries(before)
    .map(([key, value]) => `${key} = ${value}`)
    .join("; ");
  const beforeOperation = options.outputProjectionThrows
    ? "throw 'C:\\unit-test-raw-output-path'"
    : `[ordered]@{ outputProjectionValid = $${
      options.outputProjectionValid === false ? "false" : "true"
    }; ${beforeEntries} }`;
  const repositoryClean = options.repositoryClean === false ? "$false" : "$true";
  const repositoryCommit = options.repositoryCommit ?? fixture.manifest.repository.commit;
  const fileHash = options.fileHash ?? fixture.manifest.files[0]!.sha256;
  const runtimeClosure = {
    sha256: fixture.manifest.release.runtimeClosureSha256,
    fileCount: fixture.manifest.release.runtimeClosureFileCount,
    totalBytes: fixture.manifest.release.runtimeClosureTotalBytes,
    ...options.runtimeClosureOverrides,
  };
  const executionBinding = {
    releaseExecutablePath: fixture.manifest.release.executablePath,
    releaseExecutableSha256: fixture.manifest.release.executableSha256,
    verifierExecutablePath: fixture.manifest.release.verifierExecutablePath,
    verifierExecutableSha256: fixture.manifest.release.verifierExecutableSha256,
    verifierScriptPath: fixture.manifest.release.verifierScriptPath,
    verifierScriptSha256: fixture.manifest.release.verifierScriptSha256,
    gitExecutablePath: fixture.manifest.repository.gitExecutablePath,
    gitExecutableSha256: fixture.manifest.repository.gitExecutableSha256,
    signToolPath: fixture.manifest.release.signToolPath,
    signToolSha256: fixture.manifest.release.signToolSha256,
    runtimeHelperSha256: "3".repeat(64),
    commandLineProbeSha256: "4".repeat(64),
    artifactParentReady: true,
    packageBinReady: true,
    ...options.executionBindingOverrides,
  };
  const executionBindingSource = Object.entries(executionBinding)
    .map(([key, value]) => `${key} = ${typeof value === "boolean" ? `$${value}` : `'${escapePowerShell(value)}'`}`)
    .join("; ");
  const markerCreated = options.markerCreated === false ? "$false" : "$true";
  const releaseResultSource = options.releaseResultSource ??
    "[ordered]@{ releaseInvocations = 1; nestedMakeInvocations = 1; forbiddenLifecycleCount = 0; externalPublicationCount = 0 }";
  const bundleResultSource = options.bundleResultSource ??
    "[ordered]@{ published = $true; artifactManifestSha256 = ('d' * 64); signatureVerified = $true; bridgePredecessorVerified = $true; artifactVerified = $true; bridgeDiagnosticInvocationCount = 5 }";
  const releaseAuditEffect = options.releaseCreatesPartialAudit
    ? "$auditPath = Join-Path (Split-Path -Parent $Manifest.paths.consumedMarker) 'bridge-diagnostics.tokens'; [IO.File]::WriteAllText($auditPath, \"identity`n\"); & $fail 'release-after-audit';"
    : "";
  const failedStages = (options.failedStages ?? [])
    .map((stage) => `'${escapePowerShell(stage)}'`)
    .join(",");
  const residue = { ...emptyResidue, ...options.residueOverrides };
  const residueEntries = Object.entries(residue)
    .map(([key, value]) => `${key} = ${value}`)
    .join("; ");
  const outputOperationSources = options.realOutputEffects
    ? {
      preserve: [
        "param($OutputRoots, $RecoveryRoot, $PreservedState)",
        "& $record 'PreserveOutputRoot'",
        "$roots = @($OutputRoots); if ($roots.Count -ne 2 -or -not [string]::Equals($roots[0], (Join-Path $Manifest.repository.root 'dist'), [StringComparison]::OrdinalIgnoreCase) -or -not [string]::Equals($roots[1], (Join-Path $Manifest.repository.root 'out'), [StringComparison]::OrdinalIgnoreCase) -or -not [string]::Equals($RecoveryRoot, (Join-Path (Split-Path -Parent $Manifest.paths.consumedMarker) 'recovery'), [StringComparison]::OrdinalIgnoreCase)) { throw 'preservation-contract-invalid' }",
        "& $fail 'output-preservation'",
        "[IO.Directory]::CreateDirectory($RecoveryRoot) | Out-Null",
        "$PreservedState.recoveryCreated = $true",
        "[void]$operationArguments.Add('PreserveOutputRoot:recovery-state-written')",
        "& $fail 'output-preservation-after-recovery-state'",
        "if ($failedStages -ccontains 'output-preservation-neither-dist') { $PreservedState.dist = 'moving'; [void]$operationArguments.Add('PreserveOutputRoot:dist-move-declared:no-original:no-recovery'); throw 'C:\\unit-test-raw-output-path\\secret-value' }",
        "foreach ($root in @($OutputRoots)) {",
        "  $name = [IO.Path]::GetFileName($root)",
        "  if ([IO.Directory]::Exists($root)) {",
        "    $destination = Join-Path $RecoveryRoot $name",
        "    $PreservedState[$name] = 'moving'",
        "    [void]$operationArguments.Add(('PreserveOutputRoot:' + $name + '-move-declared'))",
        "    & $fail ('output-preservation-before-' + $name + '-move')",
        "    [IO.Directory]::Move($root, $destination)",
        "    $PreservedState[$name] = 'preserved'",
        "    [void]$operationArguments.Add(('PreserveOutputRoot:' + $name + '-moved'))",
        "    if ($failedStages -ccontains ('output-preservation-ambiguous-' + $name)) { Copy-Item -LiteralPath $destination -Destination $root -Recurse -Force; throw 'C:\\unit-test-raw-output-path\\secret-value' }",
        "    & $fail ('output-preservation-after-' + $name)",
        "  } else { $PreservedState[$name] = 'absent' }",
        "}",
        "$PreservedState.preservationComplete = $true",
        "$PreservedState",
      ].join("; "),
      removeGenerated: [
        "param($RepositoryRoot, $LiteralPath)",
        "& $record 'RemoveGeneratedOutput'",
        "if ($LiteralPath -cnotin @((Join-Path $RepositoryRoot 'dist'), (Join-Path $RepositoryRoot 'out'))) { throw 'generated-output-contract-invalid' }",
        "$name = [IO.Path]::GetFileName($LiteralPath)",
        "[void]$operationArguments.Add(('RemoveGeneratedOutput:' + $name))",
        "& $fail ('generated-' + $name + '-removal')",
        "if ([IO.Directory]::Exists($LiteralPath)) { [IO.Directory]::Delete($LiteralPath, $true) }",
      ].join("; "),
      restore: [
        "param($RepositoryRoot, $RecoveryRoot, $Preserved)",
        "& $record 'RestoreOutputRoot'",
        "if (-not [string]::Equals($RecoveryRoot, (Join-Path (Split-Path -Parent $Manifest.paths.consumedMarker) 'recovery'), [StringComparison]::OrdinalIgnoreCase)) { throw 'recovery-contract-invalid' }",
        "[void]$operationArguments.Add('RestoreOutputRoot:recovery')",
        "[void]$operationArguments.Add(('RestoreOutputRoot:state-' + $(if ($Preserved.recoveryCreated) { 'created' } else { 'not-created' })))",
        "& $fail 'output-restoration'",
        "$uncertain = $false",
        "foreach ($name in @('dist','out')) {",
        "  if ($Preserved[$name] -cin @('moving','preserved')) {",
        "    $source = Join-Path $RecoveryRoot $name; $destination = Join-Path $RepositoryRoot $name",
        "    $sourceExists = [IO.Directory]::Exists($source); $destinationExists = [IO.Directory]::Exists($destination)",
        "    [void]$operationArguments.Add(('RestoreOutputRoot:' + $name + ':' + $(if ($destinationExists) { 'original' } else { 'no-original' }) + ':' + $(if ($sourceExists) { 'recovery' } else { 'no-recovery' })))",
        "    if ($sourceExists -and -not $destinationExists) { [IO.Directory]::Move($source, $destination) }",
        "    if ($sourceExists -eq $destinationExists) { $uncertain = $true }",
        "  }",
        "}",
        "if ($uncertain) { throw 'restoration-presence-uncertain' }",
        "if ([IO.Directory]::Exists($RecoveryRoot)) { [IO.Directory]::Delete($RecoveryRoot, $true) }",
        "[ordered]@{ restored = $true }",
      ].join("; "),
    }
    : {
      preserve: "param($OutputRoots, $RecoveryRoot, $PreservedState); & $record 'PreserveOutputRoot'; $roots = @($OutputRoots); if ($roots.Count -ne 2 -or -not [string]::Equals($roots[0], (Join-Path $Manifest.repository.root 'dist'), [StringComparison]::OrdinalIgnoreCase) -or -not [string]::Equals($roots[1], (Join-Path $Manifest.repository.root 'out'), [StringComparison]::OrdinalIgnoreCase) -or -not [string]::Equals($RecoveryRoot, (Join-Path (Split-Path -Parent $Manifest.paths.consumedMarker) 'recovery'), [StringComparison]::OrdinalIgnoreCase)) { throw 'preservation-contract-invalid' }; & $fail 'output-preservation'; $PreservedState.dist = 'absent'; $PreservedState.out = 'absent'; $PreservedState.recoveryCreated = $false; $PreservedState.preservationComplete = $true; $PreservedState",
      removeGenerated: "param($RepositoryRoot, $LiteralPath); & $record 'RemoveGeneratedOutput'; if ($LiteralPath -cnotin @((Join-Path $RepositoryRoot 'dist'), (Join-Path $RepositoryRoot 'out'))) { throw 'generated-output-contract-invalid' }; $name = [IO.Path]::GetFileName($LiteralPath); [void]$operationArguments.Add(('RemoveGeneratedOutput:' + $name)); & $fail ('generated-' + $name + '-removal')",
      restore: "param($RepositoryRoot, $RecoveryRoot, $Preserved); & $record 'RestoreOutputRoot'; if (-not [string]::Equals($RecoveryRoot, (Join-Path (Split-Path -Parent $Manifest.paths.consumedMarker) 'recovery'), [StringComparison]::OrdinalIgnoreCase)) { throw 'recovery-contract-invalid' }; [void]$operationArguments.Add('RestoreOutputRoot:recovery'); [void]$operationArguments.Add(('RestoreOutputRoot:state-' + $(if ($Preserved.recoveryCreated) { 'created' } else { 'not-created' }))); & $fail 'output-restoration'; [ordered]@{ restored = $true }",
    };
  const markerOperationSource = options.realOutputEffects
    ? "param($LiteralPath, $Marker); & $record 'CreateConsumedMarkerAtomic'; $json = $Marker | ConvertTo-Json -Compress; $stream = [IO.File]::Open($LiteralPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None); try { $bytes = [Text.UTF8Encoding]::new($false).GetBytes($json); $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }; $true"
    : `param($LiteralPath, $Marker); & $record 'CreateConsumedMarkerAtomic'; ${markerCreated}`;
  const releaseEffect = options.realOutputEffects
    ? "$dist = Join-Path $Manifest.repository.root 'dist'; $out = Join-Path $Manifest.repository.root 'out'; [IO.Directory]::CreateDirectory((Join-Path $dist 'squirrel-vendor')) | Out-Null; [IO.Directory]::CreateDirectory($out) | Out-Null; [IO.File]::WriteAllText((Join-Path $dist 'generated.bin'), 'generated'); [IO.File]::WriteAllText((Join-Path $out 'generated.bin'), 'generated');"
    : "";
  const bundleEffect = options.realOutputEffects
    ? "$parent = Split-Path -Parent $Manifest.paths.artifactRoot; [IO.Directory]::CreateDirectory($parent) | Out-Null; [IO.Directory]::CreateDirectory($PublicationState.stagingRoot) | Out-Null; [IO.File]::WriteAllText((Join-Path $PublicationState.stagingRoot 'artifact-manifest.json'), '{\"schema\":\"closed-test-bundle\"}'); [void]$operationArguments.Add('PublishClosedArtifactBundle:staging-written'); & $fail 'closed-bundle-publication-after-staging-write'; [IO.Directory]::Move($PublicationState.stagingRoot, $PublicationState.finalRoot); [void]$operationArguments.Add('PublishClosedArtifactBundle:final-promoted'); & $fail 'closed-bundle-publication-after-final-move'; $PublicationState.published = $true;"
    : "$PublicationState.published = $true;";
  const receiptOperationSource = options.realOutputEffects
    ? "param($LiteralPath, $Receipt); & $record 'WriteReceiptAtomic'; & $fail 'receipt-writing'; Write-IntentArcSignedReleaseReceiptAtomic -LiteralPath $LiteralPath -Receipt $Receipt -ExpectedRunId $Manifest.run.id; $receiptCapture.Value = $Receipt"
    : "param($LiteralPath, $Receipt); & $record 'WriteReceiptAtomic'; & $fail 'receipt-writing'; $receiptCapture.Value = $Receipt";
  const interruptionEffect = options.stopMode === "interruption"
    ? "$cancellation.Cancel()"
    : "";
  const timeoutEffect = options.stopMode === "timeout"
    ? "throw 'timeout'"
    : "";
  const publicationCancellationEffect = options.cancellationAfterPublication
    ? "$cancellation.Cancel();"
    : "";
  const source = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    `. '${escapePowerShell(controllerScriptPath)}'`,
    `$manifest = Read-IntentArcSignedAuthorizationManifest -LiteralPath '${escapePowerShell(fixture.manifestPath)}' -ExpectedSha256 '${fixture.expectedSha256}' -ActualInvocation '${escapePowerShell(fixture.actualInvocation)}'`,
    "$operationsSeen = New-Object Collections.ArrayList",
    "$operationArguments = New-Object Collections.ArrayList",
    "$receiptCapture = [pscustomobject]@{ Value = $null }",
    "$settlementCount = [pscustomobject]@{ Value = 0 }",
    "$cancellation = New-Object Threading.CancellationTokenSource",
    `$deadlineUtc = [DateTime]::UtcNow.AddMilliseconds(${options.stopMode === "deadline" ? -1 : 30000})`,
    `$failedStages = @(${failedStages})`,
    "$record = { param([string] $Name); [void]$operationsSeen.Add($Name) }.GetNewClosure()",
    "$fail = { param([string] $Stage); if ($failedStages -ccontains $Stage) { throw 'C:\\unit-test-raw-output-path\\secret-value' } }.GetNewClosure()",
    "$operations = @{",
    `  GetRepositoryState = { param($Manifest); & $record 'GetRepositoryState'; [ordered]@{ clean = ${repositoryClean}; commit = '${escapePowerShell(repositoryCommit)}' } }.GetNewClosure()`,
    `  GetFileHash = { param($LiteralPath); & $record 'GetFileHash'; '${escapePowerShell(fileHash)}' }.GetNewClosure()`,
    `  BindExecutionInputs = { param($Manifest); & $record 'BindExecutionInputs'; [ordered]@{ ${executionBindingSource} } }.GetNewClosure()`,
    `  GetTrackedFileInventory = { param($Manifest); & $record 'GetTrackedFileInventory'; @(${(options.trackedFiles ?? []).map((path) => `'${escapePowerShell(path)}'`).join(",")}${options.trackedFiles === undefined ? "$Manifest.files | ForEach-Object { [string]$_.path }" : ""}) }.GetNewClosure()`,
    `  GetRuntimeClosure = { param($Manifest); & $record 'GetRuntimeClosure'; [ordered]@{ sha256 = '${runtimeClosure.sha256}'; fileCount = ${runtimeClosure.fileCount}; totalBytes = ${runtimeClosure.totalBytes} } }.GetNewClosure()`,
    `  GetBeforeProjection = { param($Manifest); & $record 'GetBeforeProjection'; ${beforeOperation} }.GetNewClosure()`,
    `  CreateConsumedMarkerAtomic = { ${markerOperationSource} }.GetNewClosure()`,
    `  PreserveOutputRoot = { ${outputOperationSources.preserve} }.GetNewClosure()`,
    "  PrepareCertificate = { param($Manifest, $PreparationState); & $record 'PrepareCertificate'; $PreparationState.thumbprint = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'; if ($failedStages -ccontains 'certificate-create') { throw 'IntentArc signing certificate preparation failed: certificate-create.' }; $PreparationState.keyIdentifier = 'unit-test-private-key'; if ($failedStages -ccontains 'private-key-open') { throw 'IntentArc signing certificate preparation failed: private-key-open.' }; $PreparationState.pfxPath = $Manifest.paths.pfx; [IO.File]::WriteAllText($PreparationState.pfxPath, 'test-pfx'); if ($failedStages -ccontains 'certificate-export') { throw 'IntentArc signing certificate preparation failed: certificate-export.' }; $PreparationState.cerPath = $Manifest.paths.cer; [IO.File]::WriteAllText($PreparationState.cerPath, 'test-cer'); if ($failedStages -ccontains 'public-certificate-export') { throw 'IntentArc signing certificate preparation failed: public-certificate-export.' }; if ($failedStages -ccontains 'thumbprint-verify') { throw 'IntentArc signing certificate preparation failed: thumbprint-verify.' }; $PreparationState }.GetNewClosure()",
    "  AddTrust = { param($Thumbprint, $TrustStore); & $record 'AddTrust'; if ($Thumbprint -cnotmatch '^[0-9A-F]{40}$' -or $TrustStore -cnotin @('Cert:\\CurrentUser\\Root','Cert:\\CurrentUser\\TrustedPublisher')) { throw 'trust-add-contract-invalid' }; $label = if ($TrustStore -ceq 'Cert:\\CurrentUser\\Root') { 'Root' } else { 'TrustedPublisher' }; [void]$operationArguments.Add(('AddTrust:' + $label)); if ($label -ceq 'TrustedPublisher') { & $fail 'trusted-publisher-trust' } else { & $fail 'root-trust' } }.GetNewClosure()",
    "  VerifyTrust = { param($Thumbprint, $TrustStores); & $record 'VerifyTrust'; $true }.GetNewClosure()",
    `  SetSigningEnvironment = { param($Manifest, $Certificate); & $record 'SetSigningEnvironment'; ${interruptionEffect} }.GetNewClosure()`,
    `  InvokeRelease = { param($Manifest, $Control); & $record 'InvokeRelease'; if ($null -eq $Control -or $Control.deadlineUtc -ne $deadlineUtc) { throw 'control-contract-invalid' }; if ($failedStages -ccontains 'bridge-diagnostic-audit') { throw 'bridge-diagnostic-audit' }; & $fail 'release'; ${releaseAuditEffect} ${releaseEffect} ${timeoutEffect}; ${releaseResultSource} }.GetNewClosure()`,
    "  VerifyRelease = { param($Manifest, $Thumbprint); & $record 'VerifyRelease'; if ($failedStages -ccontains 'signature-verification') { throw 'signature-verification' }; [ordered]@{ signatureVerified = $true } }.GetNewClosure()",
    `  PublishClosedArtifactBundle = { param($Manifest, $Thumbprint, $PublicationState, $Control); & $record 'PublishClosedArtifactBundle'; foreach ($stage in @('bridge-predecessor-verification','artifact-verification')) { if ($failedStages -ccontains $stage) { throw $stage } }; & $fail 'closed-bundle-publication'; ${bundleEffect} ${publicationCancellationEffect} ${bundleResultSource} }.GetNewClosure()`,
    "  SettleDescendants = { param($Manifest); & $record 'SettleDescendants'; $settlementCount.Value++; if (($failedStages -ccontains 'descendant-settlement') -and $settlementCount.Value -gt 1) { throw 'unit-test-descendant-settlement' }; [ordered]@{ processCount = 0 } }.GetNewClosure()",
    "  ClearSigningEnvironment = { & $record 'ClearSigningEnvironment'; & $fail 'signing-environment-clear' }.GetNewClosure()",
    "  RemoveTrust = { param($Thumbprint, $TrustStore); & $record 'RemoveTrust'; if ($null -ne $Thumbprint -and $Thumbprint -cnotmatch '^[0-9A-F]{40}$') { throw 'trust-removal-contract-invalid' }; if ($TrustStore -cnotin @('Cert:\\CurrentUser\\Root','Cert:\\CurrentUser\\TrustedPublisher')) { throw 'trust-removal-contract-invalid' }; $label = if ($TrustStore -ceq 'Cert:\\CurrentUser\\Root') { 'Root' } else { 'TrustedPublisher' }; [void]$operationArguments.Add(('RemoveTrust:' + $label + ':' + $(if ($null -eq $Thumbprint) { 'null' } else { 'thumbprint' }))); if ($label -ceq 'TrustedPublisher') { & $fail 'trusted-publisher-trust-removal' } else { & $fail 'root-trust-removal' } }.GetNewClosure()",
    "  RemoveCertificate = { param($Thumbprint, $MyStore); & $record 'RemoveCertificate'; if ($MyStore -cne 'Cert:\\CurrentUser\\My' -or ($null -ne $Thumbprint -and $Thumbprint -cnotmatch '^[0-9A-F]{40}$')) { throw 'certificate-removal-contract-invalid' }; [void]$operationArguments.Add(('RemoveCertificate:My:' + $(if ($null -eq $Thumbprint) { 'null' } else { 'thumbprint' }))); & $fail 'my-certificate-removal' }.GetNewClosure()",
    "  RemoveCngKey = { param($KeyIdentifier); & $record 'RemoveCngKey'; if ($null -ne $KeyIdentifier -and $KeyIdentifier -cne 'unit-test-private-key' -and $KeyIdentifier -cne $Manifest.certificate.keyContainerName) { throw 'cng-removal-contract-invalid' }; [void]$operationArguments.Add(('RemoveCngKey:' + $(if ($null -eq $KeyIdentifier) { 'null' } else { 'known' }))); & $fail 'cng-key-removal' }.GetNewClosure()",
    "  RemoveExactFile = { param($LiteralPath); & $record 'RemoveExactFile'; if ($null -eq $LiteralPath) { [void]$operationArguments.Add('RemoveExactFile:null'); return }; if ($LiteralPath -cnotin @($Manifest.paths.pfx, $Manifest.paths.cer)) { throw 'exact-file-contract-invalid' }; $label = [IO.Path]::GetExtension($LiteralPath).TrimStart('.').ToLowerInvariant(); [void]$operationArguments.Add(('RemoveExactFile:' + $label)); if ($label -ceq 'pfx') { & $fail 'pfx-removal' } else { & $fail 'cer-removal' }; if ([IO.File]::Exists($LiteralPath)) { [IO.File]::Delete($LiteralPath) } }.GetNewClosure()",
    "  RemoveRuntime = { param($LiteralPath); & $record 'RemoveRuntime'; if (-not [string]::Equals($LiteralPath, $Manifest.paths.runtime, [StringComparison]::OrdinalIgnoreCase)) { throw 'runtime-removal-contract-invalid' }; [void]$operationArguments.Add('RemoveRuntime:runtime'); & $fail 'runtime-removal'; if ([IO.Directory]::Exists($LiteralPath)) { [IO.Directory]::Delete($LiteralPath, $true) } }.GetNewClosure()",
    "  RemovePartialArtifactBundle = { param($ArtifactRoot, $LiteralPath); & $record 'RemovePartialArtifactBundle'; if (-not [string]::Equals($ArtifactRoot, $Manifest.paths.artifactRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'artifact-rollback-contract-invalid' }; $label = if ([string]::Equals($LiteralPath, ($ArtifactRoot + '.staging'), [StringComparison]::OrdinalIgnoreCase)) { 'staging' } elseif ([string]::Equals($LiteralPath, $ArtifactRoot, [StringComparison]::OrdinalIgnoreCase)) { 'final' } else { throw 'artifact-rollback-contract-invalid' }; [void]$operationArguments.Add(('RemovePartialArtifactBundle:' + $label)); & $fail ('artifact-bundle-' + $label + '-rollback'); if ([IO.Directory]::Exists($LiteralPath)) { [IO.Directory]::Delete($LiteralPath, $true) } }.GetNewClosure()",
    `  RemoveGeneratedOutput = { ${outputOperationSources.removeGenerated} }.GetNewClosure()`,
    `  RestoreOutputRoot = { ${outputOperationSources.restore} }.GetNewClosure()`,
    `  GetAfterProjection = { param($Manifest, $Before); & $record 'GetAfterProjection'; & $fail 'after-projection'; $bundleResidue = [IO.Directory]::Exists($Manifest.paths.artifactRoot + '.staging') -or (($failedStages -match '^closed-bundle-publication') -and [IO.Directory]::Exists($Manifest.paths.artifactRoot)); [ordered]@{ storeProjectionRestored = $true; outputProjectionRestored = $true; artifactPublicationClean = (-not $bundleResidue); residue = [ordered]@{ ${residueEntries} } } }.GetNewClosure()`,
    `  WriteReceiptAtomic = { ${receiptOperationSource} }.GetNewClosure()`,
    "}",
    "try {",
    `  $result = Invoke-IntentArcSignedReleaseOnce -Manifest $manifest -Operations $operations -ActualInvocation '${escapePowerShell(fixture.actualInvocation)}' -CancellationToken $cancellation.Token -DeadlineUtc $deadlineUtc`,
    options.captureArguments
      ? "  [ordered]@{ ok = $true; result = $result; operations = @($operationsSeen); operationArguments = @($operationArguments); receipt = $receiptCapture.Value } | ConvertTo-Json -Depth 8 -Compress"
      : "  [ordered]@{ ok = $true; result = $result; operations = @($operationsSeen); receipt = $receiptCapture.Value } | ConvertTo-Json -Depth 8 -Compress",
    "} catch {",
    options.captureArguments
      ? "  [ordered]@{ ok = $false; error = $_.Exception.Message; operations = @($operationsSeen); operationArguments = @($operationArguments); receipt = $receiptCapture.Value } | ConvertTo-Json -Depth 8 -Compress"
      : "  [ordered]@{ ok = $false; error = $_.Exception.Message; operations = @($operationsSeen); receipt = $receiptCapture.Value } | ConvertTo-Json -Depth 8 -Compress",
    "}",
  ].join("\r\n");
  const testScriptPath = `${fixture.manifestPath}.controller-test.ps1`;
  await writeFile(testScriptPath, source, "utf8");
  const result = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-File", testScriptPath],
    {
      encoding: "utf8",
      env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR },
      maxBuffer: 32 * 1024,
      timeout: 30_000,
      windowsHide: true,
    },
  );
  if ((options.failedStages ?? []).includes("receipt-writing")) {
    expect(result.stderr.trim()).toBe('{"status":"FAIL","category":"receipt-writing"}');
  } else {
    expect(result.stderr).toBe("");
  }
  return JSON.parse(result.stdout) as {
    ok: boolean;
    error?: string;
    result?: Record<string, unknown>;
    operations: string[];
    operationArguments?: string[];
    receipt: Record<string, unknown> | null;
  };
};

const createResidueFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "intentarc-residue-"));
  temporaryRoots.push(root);
  const dist = join(root, "dist");
  const out = join(root, "out");
  await mkdir(join(dist, "empty"), { recursive: true });
  await mkdir(join(dist, "squirrel-vendor", "nested"), { recursive: true });
  await mkdir(out, { recursive: true });
  await writeFile(join(dist, "Alpha.TXT"), Buffer.from([0x41, 0x42]));
  await writeFile(join(dist, "squirrel-vendor", "nested", "payload.bin"), Buffer.from([0x00, 0xff, 0x10]));
  await writeFile(join(out, "read-only.txt"), "read-only", "utf8");
  await chmod(join(out, "read-only.txt"), 0o444);
  await writeFile(join(out, "zeta.txt"), "z", "utf8");
  return { root, dist, out };
};

const createFixture = async (mutate?: (manifest: Manifest) => void): Promise<Fixture> => {
  const root = await mkdtemp(join(tmpdir(), "intentarc-signed-once-"));
  temporaryRoots.push(root);
  const repositoryRoot = join(root, "repository");
  const runRoot = join(repositoryRoot, runDirectory);
  const manifestPath = join(runRoot, "signed-live-authorization-manifest.json");
  const controllerPath = join(repositoryRoot, "scripts", "signed-release-once.ps1");
  const filePath = join(repositoryRoot, "package.json");
  const releaseExecutablePath = join(repositoryRoot, "tools", "pnpm.exe");
  const verifierExecutablePath = join(repositoryRoot, "tools", "node.exe");
  const gitExecutablePath = join(repositoryRoot, "tools", "git.exe");
  const signToolPath = join(repositoryRoot, "tools", "signtool.exe");
  const verifierScriptPath = join(repositoryRoot, "scripts", "signed-artifact-bundle.mjs");
  const artifactRoot = join(
    repositoryRoot,
    ".superpowers",
    "artifacts",
    runId,
  );
  const commandTemplate = [
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    "-NoProfile",
    "-NonInteractive",
    `-File \"${controllerPath}\"`,
    "-Execute",
    `-AuthorizationManifest \"${manifestPath}\"`,
    "-ExpectedAuthorizationSha256 {MANIFEST_SHA256}",
  ].join(" ");
  const manifest: Manifest = {
    schema: "intentarc.signed-release-authorization/v1",
    run: { id: runId, maximumAttempts: 1, retryCount: 0 },
    repository: {
      root: repositoryRoot,
      commit: "a".repeat(40),
      requiredCleanTrackedWorktree: true,
      gitExecutablePath,
      gitExecutableSha256: "f".repeat(64),
    },
    files: [{ path: filePath, sha256: "b".repeat(64) }],
    certificate: {
      subject: certificateSubject,
      keyContainerName,
      myStore: "Cert:\\CurrentUser\\My",
      trustStores: [
        "Cert:\\CurrentUser\\Root",
        "Cert:\\CurrentUser\\TrustedPublisher",
      ],
      rsaBits: 3072,
      keySpec: "Signature",
      provider: "Microsoft Software Key Storage Provider",
      hashAlgorithm: "SHA256",
    },
    paths: {
      pfx: join(runRoot, "publisher.pfx"),
      cer: join(runRoot, "publisher.cer"),
      runtime: join(runRoot, "runtime"),
      consumedMarker: join(runRoot, "consumed.json"),
      receipt: join(runRoot, "receipt.json"),
      artifactRoot,
    },
    release: {
      command: ["pnpm", "desktop:release"],
      executablePath: releaseExecutablePath,
      executableSha256: "c".repeat(64),
      verifierExecutablePath,
      verifierExecutableSha256: "d".repeat(64),
      verifierScriptPath,
      verifierScriptSha256: "e".repeat(64),
      signToolPath,
      signToolSha256: "1".repeat(64),
      runtimeClosureSha256: "2".repeat(64),
      runtimeClosureFileCount: 1,
      runtimeClosureTotalBytes: 1,
      maximumReleaseInvocations: 1,
      maximumNestedMakeInvocations: 1,
      bridgeAuthorizedPredecessor: "none",
      externalPublicationCount: 0,
      forbiddenLifecycleCount: 0,
    },
    authorization: { workingDirectory: repositoryRoot, commandTemplate },
  };
  mutate?.(manifest);
  await mkdir(runRoot, { recursive: true });
  const writeJson = async (value: string) => writeFile(manifestPath, value, "utf8");
  const writeBytes = async (value: Uint8Array) => writeFile(manifestPath, value);
  await writeJson(JSON.stringify(manifest));
  const bytes = Buffer.from(await (await import("node:fs/promises")).readFile(manifestPath));
  const expectedSha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    manifestPath,
    expectedSha256,
    actualInvocation: commandTemplate.replace("{MANIFEST_SHA256}", expectedSha256),
    manifest,
    writeJson,
    writeBytes,
  };
};

const snapshotTree = async (root: string): Promise<Record<string, string>> => {
  const result: Record<string, string> = {};
  const visit = async (directory: string, prefix = "") => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}\\${entry.name}` : entry.name;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        result[relative] = "directory";
        await visit(absolute, relative);
      } else {
        result[relative] = `file:${(await readFile(absolute)).toString("hex")}`;
      }
    }
  };
  await visit(root);
  return result;
};

const pathExists = async (path: string) => {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

const runProductionBundleComposition = async (input: {
  auditText: string;
  verifierMode:
    | "count-zero"
    | "audit-signal"
    | "audit-signal-with-stdout"
    | "audit-signal-wrong-stderr-length"
    | "audit-signal-wrong-same-length-stderr"
    | "audit-shaped-exit-one"
    | "generic-signal";
}) => {
  const fixture = await createFixture();
  const repositoryRoot = fixture.manifest.repository.root;
  const artifactParent = join(repositoryRoot, ".superpowers", "artifacts");
  const verifierScript = fixture.manifest.release.verifierScriptPath;
  const evidence = {
    bridgeDiagnosticInvocationCount: 0,
    bridgeNativeVerified: true,
    bundleClosureVerified: true,
    bundleId: fixture.manifest.run.id,
    fileCount: 5,
    packageVersion: "1.2.3",
    publisher: {
      cerSha256: "c".repeat(64),
      subject: fixture.manifest.certificate.subject,
      thumbprint: "A".repeat(40),
    },
    releaseExecutablesVerified: true,
    schemaVersion: 1,
    sourceCommit: fixture.manifest.repository.commit,
    totalBytes: 5,
    verifierSha256: fixture.manifest.release.verifierScriptSha256,
  };
  const verifierSources = {
    "count-zero": `process.stdout.write(${JSON.stringify(JSON.stringify(evidence))});\n`,
    "audit-signal": "process.stderr.write('IntentArc signed artifact verification failed: bridge-diagnostic-audit.\\n'); process.exitCode = 2;\n",
    "audit-signal-with-stdout": "process.stdout.write('unexpected-output'); process.stderr.write('IntentArc signed artifact verification failed: bridge-diagnostic-audit.\\n'); process.exitCode = 2;\n",
    "audit-signal-wrong-stderr-length": "process.stderr.write('IntentArc signed artifact verification failed: bridge-diagnostic-audit.\\nX'); process.exitCode = 2;\n",
    "audit-signal-wrong-same-length-stderr": "process.stderr.write('IntentArc signed artifact verification failed: bridge-diagnostic-xudit.\\n'); process.exitCode = 2;\n",
    "audit-shaped-exit-one": "process.stderr.write('IntentArc signed artifact verification failed: bridge-diagnostic-audit.\\n'); process.exitCode = 1;\n",
    "generic-signal": "process.stderr.write('IntentArc signed artifact verification failed: bridge-native.\\n'); process.exitCode = 1;\n",
  } as const;
  const verifierSource = verifierSources[input.verifierMode];

  fixture.manifest.release.verifierExecutablePath = process.execPath;
  fixture.manifest.release.verifierExecutableSha256 = createHash("sha256")
    .update(await readFile(process.execPath))
    .digest("hex");
  await Promise.all([
    mkdir(join(repositoryRoot, "dist", "bridge"), { recursive: true }),
    mkdir(join(repositoryRoot, "out", "IntentArc-win32-x64", "resources", "bridge"), { recursive: true }),
    mkdir(join(repositoryRoot, "out", "make", "squirrel.windows", "x64"), { recursive: true }),
    mkdir(join(repositoryRoot, "scripts"), { recursive: true }),
    mkdir(artifactParent, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(repositoryRoot, "package.json"), JSON.stringify({ version: "1.2.3" }), "utf8"),
    writeFile(join(repositoryRoot, "dist", "bridge", "bridge.bin"), "bridge", "utf8"),
    writeFile(join(repositoryRoot, "out", "IntentArc-win32-x64", "IntentArc.exe"), "desktop", "utf8"),
    writeFile(join(repositoryRoot, "out", "IntentArc-win32-x64", "resources", "bridge", "IntentArc Bridge.exe"), "native", "utf8"),
    writeFile(join(repositoryRoot, "out", "make", "squirrel.windows", "x64", "IntentArc Setup.exe"), "setup", "utf8"),
    writeFile(fixture.manifest.paths.cer, "publisher", "utf8"),
    writeFile(join(repositoryRoot, runDirectory, "bridge-diagnostics.tokens"), input.auditText, "utf8"),
    writeFile(verifierScript, verifierSource, "utf8"),
  ]);
  await fixture.writeJson(JSON.stringify(fixture.manifest));

  return runControllerPowerShell([
    `$manifest = Get-Content -Raw -LiteralPath '${escapePowerShell(fixture.manifestPath)}' | ConvertFrom-Json`,
    "$operations = New-IntentArcSignedReleaseOperations",
    "$state = $operations['PublishClosedArtifactBundle'].Module.SessionState.PSVariable.GetValue('state')",
    "$state.Manifest = $manifest",
    "$state.Certificate = [pscustomobject]@{ Subject = $manifest.certificate.subject }",
    "$publication = [ordered]@{ stagingRoot = ([string]$manifest.paths.artifactRoot + '.staging'); finalRoot = [string]$manifest.paths.artifactRoot; published = $false; attempted = $true }",
    "$control = [pscustomobject]@{ cancellationToken = [Threading.CancellationToken]::None; deadlineUtc = [DateTime]::UtcNow.AddSeconds(15) }",
    "$failure = 'none'",
    "try { $bundle = & $operations['PublishClosedArtifactBundle'] $manifest ('A' * 40) $publication $control; if ($bundle.bridgeDiagnosticInvocationCount -ne 5) { throw 'bridge-diagnostic-audit' } } catch { $failure = $_.Exception.Message }",
    "$rollback = try { [void](& $operations['RemovePartialArtifactBundle'] $manifest.paths.artifactRoot $publication.stagingRoot); [void](& $operations['RemovePartialArtifactBundle'] $manifest.paths.artifactRoot $publication.finalRoot); 'none' } catch { $_.Exception.Message }",
    "[ordered]@{ failure = $failure; rollback = $rollback; stagingExists = [IO.Directory]::Exists($publication.stagingRoot) -or [IO.File]::Exists($publication.stagingRoot); finalExists = [IO.Directory]::Exists($publication.finalRoot) -or [IO.File]::Exists($publication.finalRoot); publicationMarked = [bool]$publication.published; stateMarked = [bool]$state.Published } | ConvertTo-Json -Compress",
  ].join("\r\n"));
};

const validate = async (
  fixture: Fixture,
  overrides: Partial<Pick<Fixture, "expectedSha256" | "actualInvocation">> = {},
  includeFilePath = false,
) => {
  const expectedSha256 = overrides.expectedSha256 ?? fixture.expectedSha256;
  const actualInvocation = overrides.actualInvocation ?? fixture.actualInvocation;
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    `. '${escapePowerShell(scriptPath)}'`,
    "try {",
    `  $manifest = Read-IntentArcSignedAuthorizationManifest -LiteralPath '${escapePowerShell(fixture.manifestPath)}' -ExpectedSha256 '${escapePowerShell(expectedSha256)}' -ActualInvocation '${escapePowerShell(actualInvocation)}'`,
    `  [ordered]@{ ok = $true; value = [ordered]@{ schema = $manifest.schema; runId = $manifest.run.id; maximumAttempts = $manifest.run.maximumAttempts; retryCount = $manifest.run.retryCount; externalPublicationCount = $manifest.release.externalPublicationCount; forbiddenLifecycleCount = $manifest.release.forbiddenLifecycleCount${includeFilePath ? "; filePath = $manifest.files[0].path" : ""} } } | ConvertTo-Json -Compress`,
    "} catch {",
    "  [ordered]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress",
    "}",
  ].join("\r\n");
  const result = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(command)],
    {
      encoding: "utf8",
      env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR },
      maxBuffer: 32 * 1024,
      timeout: 30_000,
      windowsHide: true,
    },
  );
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout) as {
    ok: boolean;
    error?: string;
    value?: { filePath?: string };
  };
};

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  ));
});

windowsOnly("signed release authorization manifest", () => {
  it("returns the bounded validated authorization manifest", async () => {
    const result = await validate(await createFixture());

    expect(result).toEqual({
      ok: true,
      value: {
        schema: "intentarc.signed-release-authorization/v1",
        runId,
        maximumAttempts: 1,
        retryCount: 0,
        externalPublicationCount: 0,
        forbiddenLifecycleCount: 0,
      },
    });
  });

  describe("authorization manifest fix round 1", () => {
    it("returns a normalized file path after accepting a mixed-separator path", async () => {
      const fixture = await createFixture((manifest) => {
        manifest.files[0]!.path = `${manifest.repository.root.replaceAll("\\", "/")}/./package.json`;
      });

      const result = await validate(fixture, {}, true);

      expect(result).toEqual(expect.objectContaining({
        ok: true,
        value: expect.objectContaining({
          filePath: join(fixture.manifest.repository.root, "package.json"),
        }),
      }));
    });

    it.each([
      ["a bracket wildcard path", (fixture: Fixture) => {
        fixture.manifest.files[0]!.path = join(
          fixture.manifest.repository.root,
          "package[.]json",
        );
      }],
      ["a reserved DOS device component", (fixture: Fixture) => {
        fixture.manifest.files[0]!.path = join(
          fixture.manifest.repository.root,
          "CON",
          "package.json",
        );
      }],
    ])("rejects %s", async (_name, mutate) => {
      const fixture = await createFixture();
      mutate(fixture);
      await fixture.writeJson(JSON.stringify(fixture.manifest));
      const expectedSha256 = createHash("sha256")
        .update(await (await import("node:fs/promises")).readFile(fixture.manifestPath))
        .digest("hex");
      const result = await validate(fixture, {
        expectedSha256,
        actualInvocation: fixture.manifest.authorization.commandTemplate.replaceAll(
          "{MANIFEST_SHA256}",
          expectedSha256,
        ),
      });

      expect(result).toEqual({ ok: false, error: "authorization-manifest-invalid" });
    });

    it("rejects malformed UTF-8 bytes before accepting the decoded file path", async () => {
      const fixture = await createFixture();
      const source = Buffer.from(JSON.stringify(fixture.manifest), "utf8");
      const marker = Buffer.from("package.json", "utf8");
      const markerIndex = source.indexOf(marker);
      expect(markerIndex).toBeGreaterThanOrEqual(0);
      await fixture.writeBytes(Buffer.concat([
        source.subarray(0, markerIndex),
        Buffer.from("package", "utf8"),
        Buffer.from([0xc3, 0x28]),
        Buffer.from(".json", "utf8"),
        source.subarray(markerIndex + marker.length),
      ]));
      const expectedSha256 = createHash("sha256")
        .update(await (await import("node:fs/promises")).readFile(fixture.manifestPath))
        .digest("hex");
      const result = await validate(fixture, {
        expectedSha256,
        actualInvocation: fixture.manifest.authorization.commandTemplate.replaceAll(
          "{MANIFEST_SHA256}",
          expectedSha256,
        ),
      });

      expect(result).toEqual({ ok: false, error: "authorization-manifest-invalid" });
    });
  });

  it.each([
    ["an uppercase expected digest", (fixture: Fixture) => validate(fixture, { expectedSha256: fixture.expectedSha256.toUpperCase() }), "authorization-manifest-digest"],
    ["a short expected digest", (fixture: Fixture) => validate(fixture, { expectedSha256: "a".repeat(63) }), "authorization-manifest-digest"],
    ["a non-hex expected digest", (fixture: Fixture) => validate(fixture, { expectedSha256: `${"a".repeat(63)}g` }), "authorization-manifest-digest"],
    ["a digest mismatch", (fixture: Fixture) => validate(fixture, { expectedSha256: "c".repeat(64) }), "authorization-manifest-digest"],
  ])("rejects %s before accepting a manifest", async (_name, validateFixture, expectedError) => {
    const result = await validateFixture(await createFixture());
    expect(result).toEqual({ ok: false, error: expectedError });
  });

  it.each([
    ["the exact unquoted outer command", (value: string) => value],
    ["quotes around only the fixed executable", (value: string) =>
      `"${fixedPowerShellExecutable}"${value.slice(fixedPowerShellExecutable.length)}`],
  ])("accepts %s independently in the parser and controller", async (_name, deriveActual) => {
    // Break caught: either authorization boundary retaining strict raw equality
    // would refuse the deterministic quoting Windows applies to this executable.
    const fixture = await createFixture();
    const actualInvocation = deriveActual(fixture.actualInvocation);

    expect(await validate(fixture, { actualInvocation })).toEqual(expect.objectContaining({ ok: true }));
    expect(await testControllerInvocation(
      fixture.manifest.authorization.commandTemplate,
      actualInvocation,
    )).toBe(true);
  });

  it.each([
    ["an alternate executable", (value: string) => `"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\pwsh.exe"${value.slice(fixedPowerShellExecutable.length)}`],
    ["different executable casing", (value: string) => `"c:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"${value.slice(fixedPowerShellExecutable.length)}`],
    ["forward slashes in the executable", (value: string) => `"${fixedPowerShellExecutable.replaceAll("\\", "/")}"${value.slice(fixedPowerShellExecutable.length)}`],
    ["additional launch whitespace", (value: string) => `"${fixedPowerShellExecutable}"  ${value.slice(fixedPowerShellExecutable.length + 1)}`],
    ["extra executable quotes", (value: string) => `""${fixedPowerShellExecutable}""${value.slice(fixedPowerShellExecutable.length)}`],
    ["quotes moved around the full command", (value: string) => `"${value}"`],
    ["a quoted argument", (value: string) => value.replace(" -NoProfile", " \"-NoProfile\"")],
  ])("rejects %s independently in the parser and controller", async (_name, mutateActual) => {
    // Break caught: normalization, tokenization, or permissive quote handling at
    // either boundary would authorize bytes the user never acknowledged.
    const fixture = await createFixture();
    const actualInvocation = mutateActual(fixture.actualInvocation);

    expect(await validate(fixture, { actualInvocation })).toEqual({
      ok: false,
      error: "authorization-manifest-invalid",
    });
    expect(await testControllerInvocation(
      fixture.manifest.authorization.commandTemplate,
      actualInvocation,
    )).toBe(false);
  });

  it.each([
    [
      "a missing executable boundary",
      `${fixedPowerShellExecutable}X -ExpectedAuthorizationSha256 {MANIFEST_SHA256}`,
      `"${fixedPowerShellExecutable}"X -ExpectedAuthorizationSha256 ${"a".repeat(64)}`,
    ],
    [
      "an expected command without the fixed executable prefix",
      "powershell.exe -ExpectedAuthorizationSha256 {MANIFEST_SHA256}",
      `"powershell.exe" -ExpectedAuthorizationSha256 ${"a".repeat(64)}`,
    ],
  ])("parser and controller reject quote derivation for %s", async (_name, commandTemplate, actualInvocation) => {
    // Break caught: applying quote tolerance without the exact executable-plus-
    // ASCII-space prefix would silently create a general command normalizer.
    const fixture = await createFixture();
    fixture.manifest.authorization.commandTemplate = commandTemplate;
    await fixture.writeJson(JSON.stringify(fixture.manifest));
    const expectedSha256 = createHash("sha256")
      .update(await readFile(fixture.manifestPath))
      .digest("hex");
    expect(await validate(fixture, {
      expectedSha256,
      actualInvocation: actualInvocation.replace("a".repeat(64), expectedSha256),
    })).toEqual({ ok: false, error: "authorization-manifest-invalid" });
    expect(await testControllerInvocation(commandTemplate, actualInvocation)).toBe(false);
  });

  it.each([
    ["missing Git executable path", (manifest: Manifest) => { delete (manifest.repository as Partial<Manifest["repository"]>).gitExecutablePath; }],
    ["missing Git executable digest", (manifest: Manifest) => { delete (manifest.repository as Partial<Manifest["repository"]>).gitExecutableSha256; }],
    ["extra Git binding field", (manifest: Manifest) => { (manifest.repository as unknown as Record<string, unknown>).gitUnexpected = true; }],
    ["wrong-typed Git executable path", (manifest: Manifest) => { (manifest.repository as unknown as Record<string, unknown>).gitExecutablePath = 1; }],
    ["wrong-typed Git executable digest", (manifest: Manifest) => { (manifest.repository as unknown as Record<string, unknown>).gitExecutableSha256 = 1; }],
    ["missing SignTool path", (manifest: Manifest) => { delete (manifest.release as Partial<Manifest["release"]>).signToolPath; }],
    ["missing SignTool digest", (manifest: Manifest) => { delete (manifest.release as Partial<Manifest["release"]>).signToolSha256; }],
    ["extra SignTool binding field", (manifest: Manifest) => { (manifest.release as unknown as Record<string, unknown>).signToolUnexpected = true; }],
    ["wrong-typed SignTool path", (manifest: Manifest) => { (manifest.release as unknown as Record<string, unknown>).signToolPath = 1; }],
    ["wrong-typed SignTool digest", (manifest: Manifest) => { (manifest.release as unknown as Record<string, unknown>).signToolSha256 = 1; }],
    ["missing runtime closure digest", (manifest: Manifest) => { delete (manifest.release as Partial<Manifest["release"]>).runtimeClosureSha256; }],
    ["missing runtime closure file count", (manifest: Manifest) => { delete (manifest.release as Partial<Manifest["release"]>).runtimeClosureFileCount; }],
    ["missing runtime closure byte count", (manifest: Manifest) => { delete (manifest.release as Partial<Manifest["release"]>).runtimeClosureTotalBytes; }],
    ["extra runtime closure field", (manifest: Manifest) => { (manifest.release as unknown as Record<string, unknown>).runtimeClosureUnexpected = true; }],
    ["wrong-typed runtime closure digest", (manifest: Manifest) => { (manifest.release as unknown as Record<string, unknown>).runtimeClosureSha256 = 1; }],
    ["wrong-typed runtime closure file count", (manifest: Manifest) => { (manifest.release as unknown as Record<string, unknown>).runtimeClosureFileCount = "1"; }],
    ["wrong-typed runtime closure byte count", (manifest: Manifest) => { (manifest.release as unknown as Record<string, unknown>).runtimeClosureTotalBytes = "1"; }],
  ] as const)("real validator rejects %s", async (_name, mutate) => {
    // Break caught: fixture-only schema assertions can miss a production
    // validator that silently defaults, coerces, or ignores execution bindings.
    const fixture = await createFixture(mutate);

    expect(await validate(fixture)).toEqual({
      ok: false,
      error: "authorization-manifest-invalid",
    });
  });

  it("accepts the exact runtime closure count and byte ceilings", async () => {
    // Break caught: off-by-one cap validation can reject the largest closure
    // that the bounded runtime helper is explicitly allowed to report.
    const fixture = await createFixture((manifest) => {
      manifest.release.runtimeClosureFileCount = 250_000;
      manifest.release.runtimeClosureTotalBytes = 8_589_934_592;
    });

    expect(await validate(fixture)).toEqual(expect.objectContaining({ ok: true }));
  });

  it.each([
    ["invalid JSON", async (fixture: Fixture) => fixture.writeJson("{not-json")],
    ["duplicate JSON keys", async (fixture: Fixture) => fixture.writeJson(
      JSON.stringify(fixture.manifest).replace(
        '"schema":"intentarc.signed-release-authorization/v1",',
        '"schema":"intentarc.signed-release-authorization/v1","schema":"intentarc.signed-release-authorization/v1",',
      ),
    )],
    ["an unknown top-level field", async (fixture: Fixture) => { (fixture.manifest as Manifest & { unexpected?: boolean }).unexpected = true; return fixture.writeJson(JSON.stringify(fixture.manifest)); }],
    ["an unknown nested field", async (fixture: Fixture) => { (fixture.manifest.release as Manifest["release"] & { unexpected?: boolean }).unexpected = true; return fixture.writeJson(JSON.stringify(fixture.manifest)); }],
    ["caller-selected audit paths", async (fixture: Fixture) => { (fixture.manifest.paths as Manifest["paths"] & { auditRoot?: string; auditPath?: string }).auditRoot = join(fixture.manifest.repository.root, "caller-audit"); (fixture.manifest.paths as Manifest["paths"] & { auditPath?: string }).auditPath = join(fixture.manifest.repository.root, "caller-audit.tokens"); return fixture.writeJson(JSON.stringify(fixture.manifest)); }],
    ["a missing required field", async (fixture: Fixture) => { delete (fixture.manifest.paths as Partial<Manifest["paths"]>).receipt; return fixture.writeJson(JSON.stringify(fixture.manifest)); }],
    ["a relative file path", async (fixture: Fixture) => { fixture.manifest.files[0]!.path = "package.json"; return fixture.writeJson(JSON.stringify(fixture.manifest)); }],
    ["a repository escape", async (fixture: Fixture) => { fixture.manifest.files[0]!.path = join(fixture.manifest.repository.root, "..", "outside.txt"); return fixture.writeJson(JSON.stringify(fixture.manifest)); }],
    ["a LocalMachine store", async (fixture: Fixture) => { fixture.manifest.certificate.myStore = "Cert:\\LocalMachine\\My"; return fixture.writeJson(JSON.stringify(fixture.manifest)); }],
    ["a wildcard store", async (fixture: Fixture) => { fixture.manifest.certificate.trustStores[0] = "Cert:\\CurrentUser\\*"; return fixture.writeJson(JSON.stringify(fixture.manifest)); }],
    ["a wildcard path", async (fixture: Fixture) => { fixture.manifest.paths.pfx = `${fixture.manifest.paths.pfx}*`; return fixture.writeJson(JSON.stringify(fixture.manifest)); }],
    ["a prefix path", async (fixture: Fixture) => { fixture.manifest.paths.runtime = `${fixture.manifest.paths.runtime}-other`; return fixture.writeJson(JSON.stringify(fixture.manifest)); }],
    ["more than one attempt", async (fixture: Fixture) => { fixture.manifest.run.maximumAttempts = 2; return fixture.writeJson(JSON.stringify(fixture.manifest)); }],
    ["a retry", async (fixture: Fixture) => { fixture.manifest.run.retryCount = 1; return fixture.writeJson(JSON.stringify(fixture.manifest)); }],
    ["a bridge predecessor", async (fixture: Fixture) => { fixture.manifest.release.bridgeAuthorizedPredecessor = "previous"; return fixture.writeJson(JSON.stringify(fixture.manifest)); }],
    ["a missing digest token", async (fixture: Fixture) => { fixture.manifest.authorization.commandTemplate = fixture.manifest.authorization.commandTemplate.replace(" {MANIFEST_SHA256}", ""); return fixture.writeJson(JSON.stringify(fixture.manifest)); }],
    ["two digest tokens", async (fixture: Fixture) => { fixture.manifest.authorization.commandTemplate += " {MANIFEST_SHA256}"; return fixture.writeJson(JSON.stringify(fixture.manifest)); }],
    ["an ExecutionPolicy switch", async (fixture: Fixture) => { fixture.manifest.authorization.commandTemplate = fixture.manifest.authorization.commandTemplate.replace("-NoProfile", "-NoProfile -ExecutionPolicy Bypass"); return fixture.writeJson(JSON.stringify(fixture.manifest)); }],
    ["a second release command", async (fixture: Fixture) => { fixture.manifest.release.command.push("desktop:release"); return fixture.writeJson(JSON.stringify(fixture.manifest)); }],
    ["an external publication allowance", async (fixture: Fixture) => { fixture.manifest.release.externalPublicationCount = 1; return fixture.writeJson(JSON.stringify(fixture.manifest)); }],
    ["a lifecycle allowance", async (fixture: Fixture) => { fixture.manifest.release.forbiddenLifecycleCount = 1; return fixture.writeJson(JSON.stringify(fixture.manifest)); }],
    ["a runtime closure file count above its ceiling", async (fixture: Fixture) => { fixture.manifest.release.runtimeClosureFileCount = 250_001; return fixture.writeJson(JSON.stringify(fixture.manifest)); }],
    ["runtime closure bytes above their ceiling", async (fixture: Fixture) => { fixture.manifest.release.runtimeClosureTotalBytes = 8_589_934_593; return fixture.writeJson(JSON.stringify(fixture.manifest)); }],
    ["a relative release executable", async (fixture: Fixture) => { fixture.manifest.release.executablePath = "pnpm.exe"; return fixture.writeJson(JSON.stringify(fixture.manifest)); }],
    ["a release command shim", async (fixture: Fixture) => { fixture.manifest.release.executablePath = join(fixture.manifest.repository.root, "pnpm.cmd"); return fixture.writeJson(JSON.stringify(fixture.manifest)); }],
    ["an uppercase release executable digest", async (fixture: Fixture) => { fixture.manifest.release.executableSha256 = "A".repeat(64); return fixture.writeJson(JSON.stringify(fixture.manifest)); }],
    ["a relative verifier executable", async (fixture: Fixture) => { fixture.manifest.release.verifierExecutablePath = "node.exe"; return fixture.writeJson(JSON.stringify(fixture.manifest)); }],
    ["an uppercase verifier executable digest", async (fixture: Fixture) => { fixture.manifest.release.verifierExecutableSha256 = "B".repeat(64); return fixture.writeJson(JSON.stringify(fixture.manifest)); }],
    ["a noncanonical verifier script", async (fixture: Fixture) => { fixture.manifest.release.verifierScriptPath = join(fixture.manifest.repository.root, "scripts", "other.mjs"); return fixture.writeJson(JSON.stringify(fixture.manifest)); }],
    ["an uppercase verifier script digest", async (fixture: Fixture) => { fixture.manifest.release.verifierScriptSha256 = "C".repeat(64); return fixture.writeJson(JSON.stringify(fixture.manifest)); }],
    ["an unbound CNG key container", async (fixture: Fixture) => { fixture.manifest.certificate.keyContainerName = "ambient-key"; return fixture.writeJson(JSON.stringify(fixture.manifest)); }],
  ])("rejects %s", async (_name, mutate) => {
    const fixture = await createFixture();
    await mutate(fixture);
    const expectedSha256 = createHash("sha256")
      .update(await (await import("node:fs/promises")).readFile(fixture.manifestPath))
      .digest("hex");
    const result = await validate(fixture, {
      expectedSha256,
      actualInvocation: fixture.manifest.authorization.commandTemplate.replaceAll(
        "{MANIFEST_SHA256}",
        expectedSha256,
      ),
    });
    expect(result).toEqual({ ok: false, error: "authorization-manifest-invalid" });
  });

  it("rejects an actual invocation that differs by one character", async () => {
    const fixture = await createFixture();
    const result = await validate(fixture, {
      actualInvocation: `${fixture.actualInvocation.slice(0, -1)}${fixture.actualInvocation.endsWith("0") ? "1" : "0"}`,
    });

    expect(result).toEqual({ ok: false, error: "authorization-manifest-invalid" });
  });

  it("dot-sources inertly when mutation commands are unavailable", async () => {
    const command = [
      "$ErrorActionPreference = 'Stop'",
      "$ProgressPreference = 'SilentlyContinue'",
      "$script:mutations = 0",
      "function global:Start-Process { $script:mutations += 1; throw 'unexpected mutation' }",
      "function global:New-SelfSignedCertificate { $script:mutations += 1; throw 'unexpected mutation' }",
      "function global:Import-Certificate { $script:mutations += 1; throw 'unexpected mutation' }",
      "function global:Import-PfxCertificate { $script:mutations += 1; throw 'unexpected mutation' }",
      "function global:Remove-Item { $script:mutations += 1; throw 'unexpected mutation' }",
      `. '${escapePowerShell(controllerScriptPath)}'`,
      "[ordered]@{ imported = $true; mutations = $script:mutations } | ConvertTo-Json -Compress",
    ].join("\r\n");
    const result = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(command)],
      {
        encoding: "utf8",
        env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR },
        maxBuffer: 32 * 1024,
        timeout: 30_000,
        windowsHide: true,
      },
    );

    expect(result.stderr).toBe("");
    expect(result.stdout).toBe('{"imported":true,"mutations":0}\r\n');
  });
});

windowsOnly("signed release dormant production operations", () => {
  it("production defaults construct inertly with the exact closed operation metadata", async () => {
    // Break caught: resolving a tool or crossing any certificate, process, import,
    // export, or removal boundary while constructing the map makes dormant import unsafe.
    const inspected = await inspectProductionDefaults();

    expect(inspected.mutations).toBe(0);
    expect(inspected.names).toEqual(controllerOperationNames);
    expect(inspected.metadata.map((entry: { name: string }) => entry.name))
      .toEqual(controllerOperationNames);
    expect(inspected.metadata.map((entry: { classification: string }) => entry.classification))
      .toEqual([
        "observation", "observation", "observation", "observation", "observation", "observation", "mutation", "mutation",
        "mutation", "mutation", "verification", "mutation", "release",
        "verification", "contained-publication", "cleanup", "cleanup", "cleanup",
        "cleanup", "cleanup", "cleanup", "cleanup", "cleanup", "cleanup",
        "cleanup", "observation", "mutation",
      ]);
    expect(inspected.metadata.find((entry: { name: string }) =>
      entry.name === "BindExecutionInputs")).toEqual({
      name: "BindExecutionInputs",
      classification: "observation",
      phase: "pre-marker",
    });
    expect(inspected.metadata.find((entry: { name: string }) =>
      entry.name === "PrepareCertificate")).toEqual({
      name: "PrepareCertificate",
      classification: "mutation",
      helper: "New-IntentArcSigningCertificate",
      myStore: "Cert:\\CurrentUser\\My",
      partialState: "immediate",
    });
    expect(inspected.metadata.find((entry: { name: string }) =>
      entry.name === "AddTrust")).toEqual({
      name: "AddTrust",
      classification: "mutation",
      stores: ["Cert:\\CurrentUser\\Root", "Cert:\\CurrentUser\\TrustedPublisher"],
      identity: "exact-thumbprint",
    });
    expect(inspected.metadata.find((entry: { name: string }) =>
      entry.name === "InvokeRelease")).toEqual({
      name: "InvokeRelease",
      classification: "release",
      executable: "manifest.release.executablePath",
      executableSha256: "manifest.release.executableSha256",
      arguments: ["desktop:release"],
      shell: false,
      maximumCallSites: 1,
    });
    expect(inspected.metadata.find((entry: { name: string }) =>
      entry.name === "PublishClosedArtifactBundle")).toEqual({
      name: "PublishClosedArtifactBundle",
      classification: "contained-publication",
      container: "preexisting-repository/.superpowers/artifacts",
      external: false,
      verifierExecutable: "manifest.release.verifierExecutablePath",
      verifierScript: "manifest.release.verifierScriptPath",
      evidence: "closed-json",
    });
    expect(inspected.metadata.find((entry: { name: string }) =>
      entry.name === "SettleDescendants")).toEqual({
      name: "SettleDescendants",
      classification: "cleanup",
      proof: "zero-active-recorded-processes",
      discoveryFailure: "descendant-settlement",
      serializesProcessIds: false,
    });
    expect(inspected.metadata.find((entry: { name: string }) =>
      entry.name === "RemovePartialArtifactBundle")).toEqual({
      name: "RemovePartialArtifactBundle",
      classification: "cleanup",
      targets: ["artifactRoot.staging", "artifactRoot.final"],
      order: ["staging", "final"],
      requiresUnpublished: true,
      ownership: "manifest-exact",
    });
    expect(JSON.stringify(inspected)).not.toMatch(
      /password|securestring|private.?key|key.?name|stdout|stderr/i,
    );
  });

  it("release child environment binds exact executable resolution without starting any executable", async () => {
    // Break caught: changing the actual ProcessStartInfo to a shim, command
    // string, shell execution, or undrained redirected streams is unsafe even
    // if the operation's audit metadata still claims otherwise.
    const root = await mkdtemp(join(tmpdir(), "intentarc-release-environment-"));
    temporaryRoots.push(root);
    const repositoryRoot = join(root, "repository");
    const pnpmRoot = join(root, "pnpm");
    const nodeRoot = join(root, "node");
    const executable = join(pnpmRoot, "pnpm.exe");
    const nodeExecutable = join(nodeRoot, "node.exe");
    const signTool = join(root, "signtool.exe");
    const packageBin = join(repositoryRoot, "node_modules", ".bin");
    const packageShim = join(packageBin, "intentarc-release-probe.cmd");
    const runtime = join(root, "runtime");
    const controlledHome = join(runtime, "home");
    const controlledConfig = join(runtime, "config");
    const emptyNpmrc = join(runtime, "empty.npmrc");
    const ambientHome = join(root, "ambient-home");
    const auditRoot = join(root, "audit-run");
    const auditPath = join(auditRoot, "bridge-diagnostics.tokens");
    await mkdir(pnpmRoot);
    await mkdir(nodeRoot);
    await mkdir(packageBin, { recursive: true });
    await writeFile(executable, "", "utf8");
    await writeFile(nodeExecutable, "", "utf8");
    await writeFile(signTool, "", "utf8");
    await writeFile(packageShim, "", "utf8");
    await mkdir(controlledHome, { recursive: true });
    await mkdir(controlledConfig);
    await mkdir(ambientHome);
    await mkdir(auditRoot);
    await writeFile(emptyNpmrc, "", "utf8");
    await writeFile(join(ambientHome, ".npmrc"), "script-shell=C:\\unsafe.cmd", "utf8");
    const result = await runControllerPowerShell([
      `$path = '${escapePowerShell(executable)}'`,
      "[Environment]::SetEnvironmentVariable('NODE_OPTIONS', '--require unsafe.js', [EnvironmentVariableTarget]::Process)",
      "[Environment]::SetEnvironmentVariable('NODE_PATH', 'C:\\unsafe', [EnvironmentVariableTarget]::Process)",
      "[Environment]::SetEnvironmentVariable('npm_config_script_shell', 'C:\\unsafe.cmd', [EnvironmentVariableTarget]::Process)",
      "[Environment]::SetEnvironmentVariable('npm_config_userconfig', 'C:\\unsafe.npmrc', [EnvironmentVariableTarget]::Process)",
      "[Environment]::SetEnvironmentVariable('npm_config_globalconfig', 'C:\\global.npmrc', [EnvironmentVariableTarget]::Process)",
      "[Environment]::SetEnvironmentVariable('PNPM_HOME', 'C:\\unsafe-pnpm', [EnvironmentVariableTarget]::Process)",
      "[Environment]::SetEnvironmentVariable('npm_lifecycle_script', 'unsafe', [EnvironmentVariableTarget]::Process)",
      "[Environment]::SetEnvironmentVariable('INTENTARC_WINDOWS_CERTIFICATE', 'C:\\bound\\publisher.pfx', [EnvironmentVariableTarget]::Process)",
      "[Environment]::SetEnvironmentVariable('INTENTARC_WINDOWS_CERTIFICATE_PASSWORD', 'bound-password', [EnvironmentVariableTarget]::Process)",
      "[Environment]::SetEnvironmentVariable('INTENTARC_WINDOWS_CERTIFICATE_THUMBPRINT', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', [EnvironmentVariableTarget]::Process)",
      "[Environment]::SetEnvironmentVariable('INTENTARC_BRIDGE_AUTHORIZED_PREDECESSOR', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', [EnvironmentVariableTarget]::Process)",
      "[Environment]::SetEnvironmentVariable('INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_ROOT', 'C:\\ambient\\audit-root', [EnvironmentVariableTarget]::Process)",
      "[Environment]::SetEnvironmentVariable('INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_PATH', 'C:\\ambient\\audit-path.tokens', [EnvironmentVariableTarget]::Process)",
      `[Environment]::SetEnvironmentVariable('HOME', '${escapePowerShell(ambientHome)}', [EnvironmentVariableTarget]::Process)`,
      `[Environment]::SetEnvironmentVariable('USERPROFILE', '${escapePowerShell(ambientHome)}', [EnvironmentVariableTarget]::Process)`,
      `$nodePath = '${escapePowerShell(nodeExecutable)}'`,
      `$startInfo = New-IntentArcReleaseProcessStartInfo -Executable $path -NodeExecutable $nodePath -SignToolPath '${escapePowerShell(signTool)}' -WorkingDirectory '${escapePowerShell(repositoryRoot)}' -RuntimeRoot '${escapePowerShell(runtime)}' -AuditRoot '${escapePowerShell(auditRoot)}' -AuditPath '${escapePowerShell(auditPath)}'`,
      `[IO.File]::WriteAllText('${escapePowerShell(auditPath)}', ('identity' + [char]10))`,
      `$preexistingAudit = try { [void](New-IntentArcReleaseProcessStartInfo -Executable $path -NodeExecutable $nodePath -SignToolPath '${escapePowerShell(signTool)}' -WorkingDirectory '${escapePowerShell(repositoryRoot)}' -RuntimeRoot '${escapePowerShell(runtime)}' -AuditRoot '${escapePowerShell(auditRoot)}' -AuditPath '${escapePowerShell(auditPath)}'); 'accepted' } catch { $_.Exception.Message }`,
      `[IO.File]::Delete('${escapePowerShell(auditPath)}')`,
      `$invalidAudit = try { [void](New-IntentArcReleaseProcessStartInfo -Executable $path -NodeExecutable $nodePath -SignToolPath '${escapePowerShell(signTool)}' -WorkingDirectory '${escapePowerShell(repositoryRoot)}' -RuntimeRoot '${escapePowerShell(runtime)}' -AuditRoot '${escapePowerShell(auditRoot)}' -AuditPath '${escapePowerShell(join(auditRoot, "caller.tokens"))}'); 'accepted' } catch { $_.Exception.Message }`,
      "$keys = @($startInfo.EnvironmentVariables.Keys | ForEach-Object { [string]$_ } | Sort-Object)",
      "$priorPath = [Environment]::GetEnvironmentVariable('PATH', [EnvironmentVariableTarget]::Process)",
      "$priorPathExt = [Environment]::GetEnvironmentVariable('PATHEXT', [EnvironmentVariableTarget]::Process)",
      "try {",
      "  [Environment]::SetEnvironmentVariable('PATH', $startInfo.EnvironmentVariables['PATH'], [EnvironmentVariableTarget]::Process)",
      "  [Environment]::SetEnvironmentVariable('PATHEXT', $startInfo.EnvironmentVariables['PATHEXT'], [EnvironmentVariableTarget]::Process)",
      "  $pnpmResolution = @(Get-Command -Name 'pnpm' -CommandType Application -ErrorAction Stop)",
      "  $nodeResolution = @(Get-Command -Name 'node' -CommandType Application -ErrorAction Stop)",
      "  $shimResolution = @(Get-Command -Name 'intentarc-release-probe' -CommandType Application -ErrorAction Stop)",
      "} finally {",
      "  [Environment]::SetEnvironmentVariable('PATH', $priorPath, [EnvironmentVariableTarget]::Process)",
      "  [Environment]::SetEnvironmentVariable('PATHEXT', $priorPathExt, [EnvironmentVariableTarget]::Process)",
      "}",
      "[ordered]@{ fileName = $startInfo.FileName; arguments = $startInfo.Arguments; workingDirectory = $startInfo.WorkingDirectory; useShellExecute = $startInfo.UseShellExecute; createNoWindow = $startInfo.CreateNoWindow; redirectStandardOutput = $startInfo.RedirectStandardOutput; redirectStandardError = $startInfo.RedirectStandardError; keys = $keys; path = $startInfo.EnvironmentVariables['PATH']; pathExt = $startInfo.EnvironmentVariables['PATHEXT']; pnpmResolution = @($pnpmResolution | ForEach-Object { $_.Path }); nodeResolution = @($nodeResolution | ForEach-Object { $_.Path }); shimResolution = @($shimResolution | ForEach-Object { $_.Path }); home = $startInfo.EnvironmentVariables['HOME']; userConfig = $startInfo.EnvironmentVariables['npm_config_userconfig']; globalConfig = $startInfo.EnvironmentVariables['npm_config_globalconfig']; localAppData = $startInfo.EnvironmentVariables['LOCALAPPDATA']; certificate = $startInfo.EnvironmentVariables['INTENTARC_WINDOWS_CERTIFICATE']; password = $startInfo.EnvironmentVariables['INTENTARC_WINDOWS_CERTIFICATE_PASSWORD']; thumbprint = $startInfo.EnvironmentVariables['INTENTARC_WINDOWS_CERTIFICATE_THUMBPRINT']; predecessor = $startInfo.EnvironmentVariables['INTENTARC_BRIDGE_AUTHORIZED_PREDECESSOR']; signTool = $startInfo.EnvironmentVariables['WINDOWS_SIGNTOOL_PATH']; auditRoot = $startInfo.EnvironmentVariables['INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_ROOT']; auditPath = $startInfo.EnvironmentVariables['INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_PATH']; preexistingAudit = $preexistingAudit; invalidAudit = $invalidAudit } | ConvertTo-Json -Compress",
    ].join("\r\n"));

    expect(result).toEqual({
      fileName: executable,
      arguments: "desktop:release",
      workingDirectory: repositoryRoot,
      useShellExecute: false,
      createNoWindow: true,
      redirectStandardOutput: true,
      redirectStandardError: true,
      keys: [
        "APPDATA", "HOME",
        "INTENTARC_BRIDGE_AUTHORIZED_PREDECESSOR",
        "INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_PATH",
        "INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_ROOT",
        "INTENTARC_WINDOWS_CERTIFICATE",
        "INTENTARC_WINDOWS_CERTIFICATE_PASSWORD",
        "INTENTARC_WINDOWS_CERTIFICATE_THUMBPRINT",
        "LOCALAPPDATA", "npm_config_globalconfig", "npm_config_userconfig",
        "PATH", "PATHEXT", "SystemRoot", "TEMP", "TMP", "USERPROFILE", "WINDIR", "WINDOWS_SIGNTOOL_PATH", "XDG_CONFIG_HOME",
      ],
      path: [pnpmRoot, nodeRoot, packageBin, join(process.env.SystemRoot!, "System32")].join(";"),
      pathExt: ".COM;.EXE;.CMD",
      pnpmResolution: [executable],
      nodeResolution: [nodeExecutable],
      shimResolution: [packageShim],
      home: controlledHome,
      userConfig: emptyNpmrc,
      globalConfig: emptyNpmrc,
      localAppData: controlledConfig,
      certificate: "C:\\bound\\publisher.pfx",
      password: "bound-password",
      thumbprint: "A".repeat(40),
      predecessor: "b".repeat(40),
      signTool,
      auditRoot,
      auditPath,
      preexistingAudit: "bridge-diagnostic-audit",
      invalidAudit: "bridge-diagnostic-audit",
    });
    expect(result.keys).not.toContain("PNPM_HOME");
    await expect(readFile(executable)).resolves.toHaveLength(0);
    await expect(readFile(nodeExecutable)).resolves.toHaveLength(0);
    await expect(readFile(packageShim)).resolves.toHaveLength(0);
  });

  it("rejects missing, wrong-leaf, or collocated Node and absent, outside-root, or reparse-backed package-bin state", async () => {
    // Break caught: accepting any unbound Node identity or package-bin path
    // lets the release child resolve a different toolchain than authorization reviewed.
    const inspect = async (kind: "missing-node" | "wrong-node" | "collapsed-tools" | "absent-bin" | "outside-bin" | "reparse-bin") => {
      const root = await mkdtemp(join(tmpdir(), `intentarc-release-invalid-${kind}-`));
      temporaryRoots.push(root);
      const repositoryRoot = join(root, "repository");
      const executable = join(root, "pnpm.exe");
      const signTool = join(root, "signtool.exe");
      const nodeExecutable = join(
        kind === "collapsed-tools" ? root : join(root, "node-runtime"),
        kind === "wrong-node" ? "runtime.exe" : "node.exe",
      );
      const runtime = join(root, "runtime");
      const packageBin = join(repositoryRoot, "node_modules", ".bin");
      await mkdir(repositoryRoot);
      await writeFile(executable, "", "utf8");
      await writeFile(signTool, "", "utf8");
      if (kind !== "missing-node") {
        await mkdir(join(root, "node-runtime"), { recursive: true });
        await writeFile(nodeExecutable, "", "utf8");
      }
      await mkdir(join(runtime, "home"), { recursive: true });
      await mkdir(join(runtime, "config"));
      await writeFile(join(runtime, "empty.npmrc"), "", "utf8");
      if (kind !== "absent-bin") {
        await mkdir(join(repositoryRoot, "node_modules"));
        if (kind === "outside-bin" || kind === "reparse-bin") {
          const target = kind === "outside-bin"
            ? join(root, "outside-package-bin")
            : join(repositoryRoot, "ordinary-package-bin-target");
          await mkdir(target);
          await symlink(target, packageBin, "junction");
        } else {
          await mkdir(packageBin);
        }
      }
      return runControllerPowerShell([
        `$failure = try { [void](New-IntentArcReleaseProcessStartInfo -Executable '${escapePowerShell(executable)}' -NodeExecutable '${escapePowerShell(nodeExecutable)}' -SignToolPath '${escapePowerShell(signTool)}' -WorkingDirectory '${escapePowerShell(repositoryRoot)}' -RuntimeRoot '${escapePowerShell(runtime)}' -AuditRoot '${escapePowerShell(root)}' -AuditPath '${escapePowerShell(join(root, "bridge-diagnostics.tokens"))}'); 'unexpected' } catch { $_.Exception.Message }`,
        "$failure | ConvertTo-Json -Compress",
      ].join("\r\n"));
    };

    await expect(inspect("missing-node")).resolves.toBe("release-process-start-invalid");
    await expect(inspect("wrong-node")).resolves.toBe("release-process-start-invalid");
    await expect(inspect("collapsed-tools")).resolves.toBe("release-process-start-invalid");
    await expect(inspect("absent-bin")).resolves.toBe("release-process-start-invalid");
    await expect(inspect("outside-bin")).resolves.toBe("release-process-start-invalid");
    await expect(inspect("reparse-bin")).resolves.toBe("release-process-start-invalid");
  });

  it.each([".npmrc", ".pnpmfile.cjs", ".pnpmfile.mjs"])("rejects repository package-manager discovery file %s before release construction", async (leaf) => {
    const root = await mkdtemp(join(tmpdir(), "intentarc-pnpm-config-"));
    temporaryRoots.push(root);
    const executable = join(root, "pnpm.exe");
    const nodeExecutable = join(root, "node.exe");
    const signTool = join(root, "signtool.exe");
    const runtime = join(root, "runtime");
    await writeFile(executable, "not executed", "utf8");
    await writeFile(nodeExecutable, "not executed", "utf8");
    await writeFile(signTool, "not executed", "utf8");
    await mkdir(join(root, "node_modules", ".bin"), { recursive: true });
    await mkdir(join(runtime, "home"), { recursive: true });
    await mkdir(join(runtime, "config"));
    await writeFile(join(runtime, "empty.npmrc"), "", "utf8");
    await writeFile(join(root, leaf), "forbidden", "utf8");
    const result = await runControllerPowerShell([
      `$isolated = Test-IntentArcRepositoryPackageManagerIsolation -RepositoryRoot '${escapePowerShell(root)}'`,
      `[Environment]::SetEnvironmentVariable('INTENTARC_WINDOWS_CERTIFICATE', 'C:\\bound\\publisher.pfx', [EnvironmentVariableTarget]::Process)`,
      `[Environment]::SetEnvironmentVariable('INTENTARC_WINDOWS_CERTIFICATE_PASSWORD', 'bound-password', [EnvironmentVariableTarget]::Process)`,
      `[Environment]::SetEnvironmentVariable('INTENTARC_WINDOWS_CERTIFICATE_THUMBPRINT', '${"A".repeat(40)}', [EnvironmentVariableTarget]::Process)`,
      `[Environment]::SetEnvironmentVariable('INTENTARC_BRIDGE_AUTHORIZED_PREDECESSOR', '${"b".repeat(40)}', [EnvironmentVariableTarget]::Process)`,
      `$construction = try { [void](New-IntentArcReleaseProcessStartInfo -Executable '${escapePowerShell(executable)}' -NodeExecutable '${escapePowerShell(nodeExecutable)}' -SignToolPath '${escapePowerShell(signTool)}' -WorkingDirectory '${escapePowerShell(root)}' -RuntimeRoot '${escapePowerShell(runtime)}' -AuditRoot '${escapePowerShell(root)}' -AuditPath '${escapePowerShell(join(root, "bridge-diagnostics.tokens"))}'); 'unexpected' } catch { $_.Exception.Message }`,
      "[ordered]@{ isolated = $isolated; construction = $construction } | ConvertTo-Json -Compress",
    ].join("\r\n"));

    expect(result).toEqual({ isolated: false, construction: "release-process-start-invalid" });
  });

  it("readiness advances the real artifact-parent binding predicate without consuming a marker", async () => {
    // Break caught: marker consumption must not precede proof that the exact
    // repository artifact parent and package-bin directories are ready.
    const fixture = await createFixture();
    const repositoryRoot = fixture.manifest.repository.root;
    fixture.manifest.paths.artifactRoot = join(
      repositoryRoot,
      ".superpowers",
      "artifacts",
      "intentarc-phase1-signed-20260830-03",
    );
    await fixture.writeJson(JSON.stringify(fixture.manifest));
    await mkdir(join(repositoryRoot, "tools"), { recursive: true });
    await mkdir(join(repositoryRoot, "scripts"), { recursive: true });
    await mkdir(join(repositoryRoot, "node_modules", ".bin"), { recursive: true });
    await writeFile(fixture.manifest.release.executablePath, "", "utf8");
    await writeFile(fixture.manifest.release.verifierExecutablePath, "", "utf8");
    await writeFile(fixture.manifest.release.verifierScriptPath, "", "utf8");
    await writeFile(fixture.manifest.repository.gitExecutablePath, "", "utf8");
    await writeFile(fixture.manifest.release.signToolPath, "", "utf8");
    await writeFile(join(repositoryRoot, "scripts", "release-runtime-closure.mjs"), "", "utf8");
    await writeFile(join(repositoryRoot, "scripts", "windows-commandline-probe.ps1"), "", "utf8");
    const missingParent = await runControllerPowerShell([
      `$manifest = Get-Content -Raw -LiteralPath '${escapePowerShell(fixture.manifestPath)}' | ConvertFrom-Json`,
      "$operations = New-IntentArcSignedReleaseOperations",
      "$failure = try { [void](& $operations['BindExecutionInputs'] $manifest); 'accepted' } catch { $_.Exception.Message }",
      `[ordered]@{ failure = $failure; markerExists = [IO.File]::Exists('${escapePowerShell(fixture.manifest.paths.consumedMarker)}') } | ConvertTo-Json -Compress`,
    ].join("\r\n"));

    expect(missingParent).toEqual({ failure: "execution-input-binding", markerExists: false });
    const readiness = await execFileAsync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-File", artifactParentReadinessScriptPath,
      "-RepositoryRoot", repositoryRoot,
      "-ArtifactRoot", fixture.manifest.paths.artifactRoot,
    ], { encoding: "utf8", env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } });
    expect(JSON.parse(readiness.stdout)).toEqual({
      schema: "intentarc.signed-release-artifact-parent-readiness/v1",
      status: "PASS",
      artifactParentReady: true,
    });
    expect(await pathExists(fixture.manifest.paths.consumedMarker)).toBe(false);

    const result = await runControllerPowerShell([
      `$manifest = Get-Content -Raw -LiteralPath '${escapePowerShell(fixture.manifestPath)}' | ConvertFrom-Json`,
      "$operations = New-IntentArcSignedReleaseOperations",
      "$binding = & $operations['BindExecutionInputs'] $manifest",
      "$binding | ConvertTo-Json -Compress",
    ].join("\r\n"));

    expect(result).toEqual({
      releaseExecutablePath: fixture.manifest.release.executablePath,
      releaseExecutableSha256: createHash("sha256").update("").digest("hex"),
      verifierExecutablePath: fixture.manifest.release.verifierExecutablePath,
      verifierExecutableSha256: createHash("sha256").update("").digest("hex"),
      verifierScriptPath: fixture.manifest.release.verifierScriptPath,
      verifierScriptSha256: createHash("sha256").update("").digest("hex"),
      gitExecutablePath: fixture.manifest.repository.gitExecutablePath,
      gitExecutableSha256: createHash("sha256").update("").digest("hex"),
      signToolPath: fixture.manifest.release.signToolPath,
      signToolSha256: createHash("sha256").update("").digest("hex"),
      runtimeHelperSha256: createHash("sha256").update("").digest("hex"),
      commandLineProbeSha256: createHash("sha256").update("").digest("hex"),
      artifactParentReady: true,
      packageBinReady: true,
    });
  });

  it.each([
    ["Git", "relative path"],
    ["Git", "wrong leaf"],
    ["Git", "reparse target"],
    ["Git", "digest mismatch"],
    ["SignTool", "relative path"],
    ["SignTool", "wrong leaf"],
    ["SignTool", "reparse target"],
    ["SignTool", "digest mismatch"],
  ] as const)("production binding refuses %s %s before marker consumption", async (binding, mutation) => {
    // Break caught: schema validation alone cannot prove the production
    // pre-marker binding rejects a substituted executable on disk.
    const fixture = await createFixture();
    const repositoryRoot = fixture.manifest.repository.root;
    await Promise.all([
      mkdir(join(repositoryRoot, "tools"), { recursive: true }),
      mkdir(join(repositoryRoot, "scripts"), { recursive: true }),
      mkdir(join(repositoryRoot, "node_modules", ".bin"), { recursive: true }),
      mkdir(join(repositoryRoot, ".superpowers", "artifacts"), { recursive: true }),
    ]);
    const files = [
      fixture.manifest.release.executablePath,
      fixture.manifest.release.verifierExecutablePath,
      fixture.manifest.release.verifierScriptPath,
      fixture.manifest.repository.gitExecutablePath,
      fixture.manifest.release.signToolPath,
      join(repositoryRoot, "scripts", "release-runtime-closure.mjs"),
      join(repositoryRoot, "scripts", "windows-commandline-probe.ps1"),
    ];
    await Promise.all(files.map((path) => writeFile(path, "binding", "utf8")));
    const digest = createHash("sha256").update("binding").digest("hex");
    fixture.manifest.release.executableSha256 = digest;
    fixture.manifest.release.verifierExecutableSha256 = digest;
    fixture.manifest.release.verifierScriptSha256 = digest;
    fixture.manifest.repository.gitExecutableSha256 = digest;
    fixture.manifest.release.signToolSha256 = digest;

    const isGit = binding === "Git";
    const original = isGit
      ? fixture.manifest.repository.gitExecutablePath
      : fixture.manifest.release.signToolPath;
    if (mutation === "relative path") {
      const relativePath = join("tools", isGit ? "git.exe" : "signtool.exe");
      if (isGit) fixture.manifest.repository.gitExecutablePath = relativePath;
      else fixture.manifest.release.signToolPath = relativePath;
    } else if (mutation === "wrong leaf") {
      const wrong = join(repositoryRoot, "tools", isGit ? "git-copy.exe" : "signtool-copy.exe");
      await writeFile(wrong, "binding", "utf8");
      if (isGit) fixture.manifest.repository.gitExecutablePath = wrong;
      else fixture.manifest.release.signToolPath = wrong;
    } else if (mutation === "reparse target") {
      const replacement = join(repositoryRoot, "tools", isGit ? "git-reparse-source" : "signtool-reparse-source");
      await rm(original);
      await mkdir(replacement);
      await symlink(replacement, original, "junction");
    } else {
      if (isGit) fixture.manifest.repository.gitExecutableSha256 = "0".repeat(64);
      else fixture.manifest.release.signToolSha256 = "0".repeat(64);
    }
    await fixture.writeJson(JSON.stringify(fixture.manifest));

    const result = await runControllerPowerShell([
      `$manifest = Get-Content -Raw -LiteralPath '${escapePowerShell(fixture.manifestPath)}' | ConvertFrom-Json`,
      "$operations = New-IntentArcSignedReleaseOperations",
      "$actualInvocation = $manifest.authorization.commandTemplate.Replace('{MANIFEST_SHA256}', ('a' * 64))",
      "$outcome = Invoke-IntentArcSignedReleaseOnce -Manifest $manifest -Operations $operations -ActualInvocation $actualInvocation",
      `[ordered]@{ category = $outcome.primaryCategory; markerConsumed = $outcome.markerConsumed; markerFile = [IO.File]::Exists('${escapePowerShell(fixture.manifest.paths.consumedMarker)}') } | ConvertTo-Json -Compress`,
    ].join("\r\n"));

    expect(result).toEqual({
      category: "execution-input-binding",
      markerConsumed: false,
      markerFile: false,
    });
  });

  it("rejects a tracked-file hash that exceeds its explicit stream cap", async () => {
    // Break caught: ReadAllBytes observes an unbounded tracked input before
    // the marker instead of applying the controller's bounded hash policy.
    const root = await mkdtemp(join(tmpdir(), "intentarc-tracked-hash-cap-"));
    temporaryRoots.push(root);
    const file = join(root, "tracked.txt");
    await writeFile(file, "abcdef", "utf8");
    const result = await runControllerPowerShell([
      `$failure = try { Get-IntentArcTrackedFileSha256 -LiteralPath '${escapePowerShell(file)}' -MaximumBytes 5 | Out-Null; 'accepted' } catch { $_.Exception.Message }`,
      "$failure | ConvertTo-Json -Compress",
    ].join("\r\n"));

    expect(result).toBe("tracked-file-hash");
  });

  it("rejects controlled-host tracked-file creation-time identity drift", async () => {
    // Break caught: length and last-write equality alone can miss replacement
    // drift on the trusted host when the observed file's creation identity changes.
    const root = await mkdtemp(join(tmpdir(), "intentarc-tracked-creation-drift-"));
    temporaryRoots.push(root);
    const file = join(root, "tracked.txt");
    await writeFile(file, "abcdef", "utf8");
    const result = await runControllerPowerShell([
      "$script:observations = 0",
      `function Get-Item { param([string]$LiteralPath, [switch]$Force, [string]$ErrorAction) $script:observations++; if ($script:observations -eq 2) { [IO.File]::SetCreationTimeUtc($LiteralPath, [IO.File]::GetCreationTimeUtc($LiteralPath).AddSeconds(2)) }; Microsoft.PowerShell.Management\\Get-Item -LiteralPath $LiteralPath -Force:$Force -ErrorAction $ErrorAction }`,
      `$failure = try { Get-IntentArcTrackedFileSha256 -LiteralPath '${escapePowerShell(file)}' -MaximumBytes 1024 | Out-Null; 'accepted' } catch { $_.Exception.Message }`,
      "$failure | ConvertTo-Json -Compress",
    ].join("\r\n"));

    expect(result).toBe("tracked-file-hash");
  });

  it("rechecks release execution inputs after descendant settlement", async () => {
    // Break caught: a release input that drifts while a recorded descendant
    // settles must refuse before verification can consume its later state.
    const fixture = await createFixture();
    const repositoryRoot = fixture.manifest.repository.root;
    await mkdir(join(repositoryRoot, "tools"), { recursive: true });
    await Promise.all([
      writeFile(fixture.manifest.release.executablePath, "pnpm", "utf8"),
      writeFile(fixture.manifest.release.verifierExecutablePath, "node", "utf8"),
      writeFile(fixture.manifest.release.signToolPath, "signtool", "utf8"),
    ]);
    fixture.manifest.release.executableSha256 = createHash("sha256").update("pnpm").digest("hex");
    fixture.manifest.release.verifierExecutableSha256 = createHash("sha256").update("node").digest("hex");
    fixture.manifest.release.signToolSha256 = createHash("sha256").update("signtool").digest("hex");
    await fixture.writeJson(JSON.stringify(fixture.manifest));
    const result = await runControllerPowerShell([
      `$manifest = Get-Content -Raw -LiteralPath '${escapePowerShell(fixture.manifestPath)}' | ConvertFrom-Json`,
      "$manifest.release.signToolSha256 = ('f' * 64)",
      "$operations = New-IntentArcSignedReleaseOperations",
      "$control = [pscustomobject]@{ cancellationToken = [Threading.CancellationToken]::None; deadlineUtc = [DateTime]::UtcNow.AddSeconds(5) }",
      "$failure = try { [void](& $operations['SettleDescendants'] $manifest $control); 'accepted' } catch { $_.Exception.Message }",
      "$failure | ConvertTo-Json -Compress",
    ].join("\r\n"));

    expect(result).toBe("execution-input-drift");
  });

  it("maps malformed runtime-helper JSON to a bounded closed error", async () => {
    // Break caught: parser details from an untrusted helper must not cross the
    // pre-marker boundary, even when the helper process itself exits cleanly.
    const root = await mkdtemp(join(tmpdir(), "intentarc-runtime-helper-json-"));
    temporaryRoots.push(root);
    const helper = join(root, "scripts", "release-runtime-closure.mjs");
    await mkdir(join(root, "scripts"), { recursive: true });
    await writeFile(helper, "process.stdout.write('{}');\n", "utf8");
    const nodeSha256 = createHash("sha256").update(await readFile(process.execPath)).digest("hex");
    const helperSha256 = createHash("sha256").update(await readFile(helper)).digest("hex");
    const result = await runControllerPowerShell([
      `$manifest = [pscustomobject]@{ repository = [pscustomobject]@{ root = '${escapePowerShell(root)}' }; release = [pscustomobject]@{ verifierExecutablePath = '${escapePowerShell(process.execPath)}'; verifierExecutableSha256 = '${nodeSha256}' } }`,
      `$failure = try { Invoke-IntentArcRuntimeClosureHelper -Manifest $manifest -ExpectedHelperSha256 '${helperSha256}' | Out-Null; 'accepted' } catch { $_.Exception.Message }`,
      "$failure | ConvertTo-Json -Compress",
    ].join("\r\n"));

    expect(result).toBe("runtime-closure-invalid");
  });

  it("runs the real runtime-closure operation from a schema-valid tracked helper binding", async () => {
    // Break caught: production GetRuntimeClosure must not read a helper hash
    // field that the exact authorization schema deliberately does not contain.
    const fixture = await createFixture();
    const repositoryRoot = fixture.manifest.repository.root;
    const helper = join(repositoryRoot, "scripts", "release-runtime-closure.mjs");
    const runtimeFile = join(repositoryRoot, "node_modules", "package", "value.txt");
    await mkdir(join(repositoryRoot, "scripts"), { recursive: true });
    await mkdir(join(repositoryRoot, "node_modules", "package"), { recursive: true });
    await copyFile(runtimeClosureHelperScriptPath, helper);
    await writeFile(runtimeFile, "runtime", "utf8");
    await writeFile(fixture.manifest.files[0].path, "package", "utf8");
    fixture.manifest.release.verifierExecutablePath = process.execPath;
    fixture.manifest.release.verifierExecutableSha256 = createHash("sha256").update(await readFile(process.execPath)).digest("hex");
    const helperSha256 = createHash("sha256").update(await readFile(helper)).digest("hex");
    fixture.manifest.files.push({ path: helper, sha256: helperSha256 });
    fixture.manifest.release.runtimeClosureFileCount = 1;
    fixture.manifest.release.runtimeClosureTotalBytes = 7;
    await fixture.writeJson(JSON.stringify(fixture.manifest));
    const manifestSha256 = createHash("sha256").update(await readFile(fixture.manifestPath)).digest("hex");
    const actualInvocation = fixture.manifest.authorization.commandTemplate.replace("{MANIFEST_SHA256}", manifestSha256);
    const result = await runControllerPowerShell([
      `$manifest = Read-IntentArcSignedAuthorizationManifest -LiteralPath '${escapePowerShell(fixture.manifestPath)}' -ExpectedSha256 '${manifestSha256}' -ActualInvocation '${escapePowerShell(actualInvocation)}'`,
      "$operations = New-IntentArcSignedReleaseOperations",
      "$firstFailure = 'none'",
      "try { $closure = & $operations['GetRuntimeClosure'] $manifest } catch { $firstFailure = $_.Exception.Message; $closure = $null }",
      `$helperPath = '${escapePowerShell(helper)}'`,
      "$helperEntry = @($manifest.files | Where-Object { [string]::Equals([string]$_.path, $helperPath, [StringComparison]::Ordinal) })",
      "$helperEntry[0].sha256 = ('f' * 64)",
      "$mismatch = try { [void](& $operations['GetRuntimeClosure'] $manifest); 'accepted' } catch { $_.Exception.Message }",
      "[ordered]@{ firstFailure = $firstFailure; closure = $closure; mismatch = $mismatch } | ConvertTo-Json -Depth 4 -Compress",
    ].join("\r\n"));

    expect(result).toEqual({
      firstFailure: "none",
      closure: {
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        fileCount: 1,
        totalBytes: 7,
      },
      mismatch: "runtime-closure-invalid",
    });
  });

  it("runs the real runtime helper child with only the fixed four-variable environment", async () => {
    // Break caught: inheriting Node, PATH, or npm configuration can execute an
    // ambient loader or change runtime traversal before marker consumption.
    const root = await mkdtemp(join(tmpdir(), "intentarc-runtime-helper-environment-"));
    temporaryRoots.push(root);
    const scripts = join(root, "scripts");
    const helper = join(scripts, "release-runtime-closure.mjs");
    const loader = join(scripts, "poison-loader.mjs");
    const loaderSentinel = join(root, "loader-sentinel.txt");
    const environmentEvidence = join(root, "runtime-environment.json");
    const consumedMarker = join(root, "consumed.json");
    await mkdir(scripts, { recursive: true });
    await writeFile(
      loader,
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(loaderSentinel)}, "loaded");\n`,
      "utf8",
    );
    await writeFile(
      helper,
      [
        "import { writeFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        "const environment = Object.fromEntries(Object.entries(process.env).sort(([left], [right]) => left.localeCompare(right)));",
        "writeFileSync(join(process.argv[3], 'runtime-environment.json'), JSON.stringify(environment));",
        "process.stdout.write(JSON.stringify({ schema: 'intentarc.release-runtime-closure/v1', sha256: 'a'.repeat(64), fileCount: 0, totalBytes: 0 }));",
      ].join("\n"),
      "utf8",
    );
    const nodeSha256 = createHash("sha256").update(await readFile(process.execPath)).digest("hex");
    const helperSha256 = createHash("sha256").update(await readFile(helper)).digest("hex");
    const result = await runControllerPowerShell([
      `[Environment]::SetEnvironmentVariable('NODE_OPTIONS', '--experimental-loader=${escapePowerShell(pathToFileURL(loader).href)}', [EnvironmentVariableTarget]::Process)`,
      "[Environment]::SetEnvironmentVariable('NODE_PATH', 'C:\\poison-node-path', [EnvironmentVariableTarget]::Process)",
      "[Environment]::SetEnvironmentVariable('PATH', 'C:\\poison-path', [EnvironmentVariableTarget]::Process)",
      "[Environment]::SetEnvironmentVariable('npm_config_userconfig', 'C:\\poison-user.npmrc', [EnvironmentVariableTarget]::Process)",
      "[Environment]::SetEnvironmentVariable('npm_config_globalconfig', 'C:\\poison-global.npmrc', [EnvironmentVariableTarget]::Process)",
      "[Environment]::SetEnvironmentVariable('npm_config_registry', 'https://invalid.example', [EnvironmentVariableTarget]::Process)",
      "[Environment]::SetEnvironmentVariable('PNPM_HOME', 'C:\\poison-pnpm', [EnvironmentVariableTarget]::Process)",
      `$manifest = [pscustomobject]@{ repository = [pscustomobject]@{ root = '${escapePowerShell(root)}' }; release = [pscustomobject]@{ verifierExecutablePath = '${escapePowerShell(process.execPath)}'; verifierExecutableSha256 = '${nodeSha256}' } }`,
      "$closure = $null",
      `$failure = try { $closure = Invoke-IntentArcRuntimeClosureHelper -Manifest $manifest -ExpectedHelperSha256 '${helperSha256}'; 'none' } catch { $_.Exception.Message }`,
      `$environment = Get-Content -Raw -LiteralPath '${escapePowerShell(environmentEvidence)}' | ConvertFrom-Json`,
      "$keys = @($environment.PSObject.Properties.Name | Sort-Object)",
      `[ordered]@{ failure = $failure; closure = $closure; keys = $keys; loaderSentinel = [IO.File]::Exists('${escapePowerShell(loaderSentinel)}'); marker = [IO.File]::Exists('${escapePowerShell(consumedMarker)}') } | ConvertTo-Json -Depth 4 -Compress`,
    ].join("\r\n"));

    expect(result).toEqual({
      failure: "none",
      closure: { sha256: "a".repeat(64), fileCount: 0, totalBytes: 0 },
      keys: ["SystemRoot", "TEMP", "TMP", "WINDIR"],
      loaderSentinel: false,
      marker: false,
    });
  });

  it("rejects the complete historical 2026-08-21 authorization binding", async () => {
    // Break caught: leaving the validator bound to the previous rehearsal
    // would authorize a stale run while refusing the fresh one.
    const historicalRunId = "intentarc-v1-closure-signed-20260821-01";
    const fixture = await createFixture();
    const historicalRunRoot = join(
      fixture.manifest.repository.root,
      ".superpowers",
      "sdd",
      "2026-08-21-intentarc-v1-closure",
      "signed-live-20260821-01",
    );
    fixture.manifest.run.id = historicalRunId;
    fixture.manifest.certificate.subject = `CN=IntentArc Release ${historicalRunId}`;
    fixture.manifest.certificate.keyContainerName = `IntentArc.Release.${historicalRunId}`;
    fixture.manifest.paths.pfx = join(historicalRunRoot, "publisher.pfx");
    fixture.manifest.paths.cer = join(historicalRunRoot, "publisher.cer");
    fixture.manifest.paths.runtime = join(historicalRunRoot, "runtime");
    fixture.manifest.paths.consumedMarker = join(historicalRunRoot, "consumed.json");
    fixture.manifest.paths.receipt = join(historicalRunRoot, "receipt.json");
    fixture.manifest.paths.artifactRoot = join(
      fixture.manifest.repository.root,
      ".superpowers",
      "artifacts",
      historicalRunId,
    );
    const historicalManifestPath = join(
      historicalRunRoot,
      "signed-live-authorization-manifest.json",
    );
    fixture.manifest.authorization.commandTemplate = [
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      `-File "${join(fixture.manifest.repository.root, "scripts", "signed-release-once.ps1")}"`,
      "-Execute",
      `-AuthorizationManifest "${historicalManifestPath}"`,
      "-ExpectedAuthorizationSha256 {MANIFEST_SHA256}",
    ].join(" ");
    await fixture.writeJson(JSON.stringify(fixture.manifest));
    const expectedSha256 = createHash("sha256")
      .update(await readFile(fixture.manifestPath))
      .digest("hex");

    expect(await validate(fixture, {
      expectedSha256,
      actualInvocation: fixture.manifest.authorization.commandTemplate.replace(
        "{MANIFEST_SHA256}",
        expectedSha256,
      ),
    })).toEqual({ ok: false, error: "authorization-manifest-invalid" });
  });

  it("rejects the complete superseded run-01 authorization binding", async () => {
    // Break caught: accepting the superseded run after rebinding would allow
    // its old subject, key, paths, and command to cross the one-shot boundary.
    const historicalRunId = "intentarc-phase1-signed-20260830-01";
    const fixture = await createFixture();
    const historicalRunRoot = join(
      fixture.manifest.repository.root,
      ".superpowers",
      "sdd",
      "2026-08-30-fresh-internal-signed-release-rehearsal",
      "signed-live-20260830-01",
    );
    fixture.manifest.run.id = historicalRunId;
    fixture.manifest.certificate.subject = `CN=IntentArc Phase 1 ${historicalRunId}`;
    fixture.manifest.certificate.keyContainerName = `IntentArc.Release.${historicalRunId}`;
    fixture.manifest.paths.pfx = join(historicalRunRoot, "publisher.pfx");
    fixture.manifest.paths.cer = join(historicalRunRoot, "publisher.cer");
    fixture.manifest.paths.runtime = join(historicalRunRoot, "runtime");
    fixture.manifest.paths.consumedMarker = join(historicalRunRoot, "consumed.json");
    fixture.manifest.paths.receipt = join(historicalRunRoot, "receipt.json");
    fixture.manifest.paths.artifactRoot = join(
      fixture.manifest.repository.root,
      ".superpowers",
      "artifacts",
      historicalRunId,
    );
    const historicalManifestPath = join(
      historicalRunRoot,
      "signed-live-authorization-manifest.json",
    );
    fixture.manifest.authorization.commandTemplate = [
      fixedPowerShellExecutable,
      "-NoProfile",
      "-NonInteractive",
      `-File "${join(fixture.manifest.repository.root, "scripts", "signed-release-once.ps1")}"`,
      "-Execute",
      `-AuthorizationManifest "${historicalManifestPath}"`,
      "-ExpectedAuthorizationSha256 {MANIFEST_SHA256}",
    ].join(" ");
    await fixture.writeJson(JSON.stringify(fixture.manifest));
    const expectedSha256 = createHash("sha256")
      .update(await readFile(fixture.manifestPath))
      .digest("hex");

    expect(await validate(fixture, {
      expectedSha256,
      actualInvocation: fixture.manifest.authorization.commandTemplate.replace(
        "{MANIFEST_SHA256}",
        expectedSha256,
      ),
    })).toEqual({ ok: false, error: "authorization-manifest-invalid" });
  });

  it("rejects the complete superseded run-02 authorization binding", async () => {
    // Break caught: accepting the terminal run-02 binding would authorize its
    // old ID, subject, key, run-root paths, artifact root, and command template.
    const historicalRunId = "intentarc-phase1-signed-20260830-02";
    const fixture = await createFixture();
    const historicalRunRoot = join(
      fixture.manifest.repository.root,
      ".superpowers",
      "sdd",
      "2026-08-30-fresh-internal-signed-release-rehearsal",
      "signed-live-20260830-02",
    );
    fixture.manifest.run.id = historicalRunId;
    fixture.manifest.certificate.subject = `CN=IntentArc Phase 1 ${historicalRunId}`;
    fixture.manifest.certificate.keyContainerName = `IntentArc.Release.${historicalRunId}`;
    fixture.manifest.paths.pfx = join(historicalRunRoot, "publisher.pfx");
    fixture.manifest.paths.cer = join(historicalRunRoot, "publisher.cer");
    fixture.manifest.paths.runtime = join(historicalRunRoot, "runtime");
    fixture.manifest.paths.consumedMarker = join(historicalRunRoot, "consumed.json");
    fixture.manifest.paths.receipt = join(historicalRunRoot, "receipt.json");
    fixture.manifest.paths.artifactRoot = join(
      fixture.manifest.repository.root,
      ".superpowers",
      "artifacts",
      historicalRunId,
    );
    const historicalManifestPath = join(
      historicalRunRoot,
      "signed-live-authorization-manifest.json",
    );
    fixture.manifest.authorization.commandTemplate = [
      fixedPowerShellExecutable,
      "-NoProfile",
      "-NonInteractive",
      `-File "${join(fixture.manifest.repository.root, "scripts", "signed-release-once.ps1")}"`,
      "-Execute",
      `-AuthorizationManifest "${historicalManifestPath}"`,
      "-ExpectedAuthorizationSha256 {MANIFEST_SHA256}",
    ].join(" ");
    await fixture.writeJson(JSON.stringify(fixture.manifest));
    const expectedSha256 = createHash("sha256")
      .update(await readFile(fixture.manifestPath))
      .digest("hex");

    expect(await validate(fixture, {
      expectedSha256,
      actualInvocation: fixture.manifest.authorization.commandTemplate.replace(
        "{MANIFEST_SHA256}",
        expectedSha256,
      ),
    })).toEqual({ ok: false, error: "authorization-manifest-invalid" });
  });

  it("refuses a manifest-valid runtime Node whose identity tuple drifts during child use", async () => {
    // Break caught: a rehash-only post-use check misses metadata drift while
    // the exact child is running, even though its bytes remain manifest-valid.
    const root = await mkdtemp(join(tmpdir(), "intentarc-runtime-node-tuple-"));
    temporaryRoots.push(root);
    const helper = join(root, "scripts", "release-runtime-closure.mjs");
    const node = join(root, "tools", "node.exe");
    await mkdir(join(root, "scripts"), { recursive: true });
    await mkdir(join(root, "tools"), { recursive: true });
    await copyFile(process.execPath, node);
    await writeFile(helper, "import { utimesSync } from 'node:fs'; const now = new Date(); utimesSync(process.execPath, now, now); process.stdout.write(JSON.stringify({ schema: 'intentarc.release-runtime-closure/v1', sha256: 'a'.repeat(64), fileCount: 0, totalBytes: 0 }));\n", "utf8");
    const nodeSha256 = createHash("sha256").update(await readFile(node)).digest("hex");
    const helperSha256 = createHash("sha256").update(await readFile(helper)).digest("hex");
    const result = await runControllerPowerShell([
      `$manifest = [pscustomobject]@{ repository = [pscustomobject]@{ root = '${escapePowerShell(root)}' }; release = [pscustomobject]@{ verifierExecutablePath = '${escapePowerShell(node)}'; verifierExecutableSha256 = '${nodeSha256}' } }`,
      `$failure = try { Invoke-IntentArcRuntimeClosureHelper -Manifest $manifest -ExpectedHelperSha256 '${helperSha256}' | Out-Null; 'accepted' } catch { $_.Exception.Message }`,
      "$failure | ConvertTo-Json -Compress",
    ].join("\r\n"));

    expect(result).toBe("runtime-closure-drift");
  });

  it("kills and settles a timed-out runtime helper before returning its closed error", async () => {
    // Break caught: disposing a timed-out helper without terminating it leaves
    // an uncontrolled observation process alive after the controller refuses.
    const root = await mkdtemp(join(tmpdir(), "intentarc-runtime-helper-timeout-"));
    temporaryRoots.push(root);
    const helper = join(root, "scripts", "release-runtime-closure.mjs");
    await mkdir(join(root, "scripts"), { recursive: true });
    await writeFile(helper, "import { writeFileSync } from 'node:fs'; import { join } from 'node:path'; writeFileSync(join(process.argv[3], 'helper.pid'), String(process.pid)); setInterval(() => {}, 1000);\n", "utf8");
    const nodeSha256 = createHash("sha256").update(await readFile(process.execPath)).digest("hex");
    const helperSha256 = createHash("sha256").update(await readFile(helper)).digest("hex");
    const result = await runControllerPowerShell([
      `$manifest = [pscustomobject]@{ repository = [pscustomobject]@{ root = '${escapePowerShell(root)}' }; release = [pscustomobject]@{ verifierExecutablePath = '${escapePowerShell(process.execPath)}'; verifierExecutableSha256 = '${nodeSha256}' } }`,
      "$control = [pscustomobject]@{ cancellationToken = [Threading.CancellationToken]::None; deadlineUtc = [DateTime]::UtcNow.AddMilliseconds(250) }",
      `$failure = try { Invoke-IntentArcRuntimeClosureHelper -Manifest $manifest -ExpectedHelperSha256 '${helperSha256}' -Control $control | Out-Null; 'accepted' } catch { $_.Exception.Message }`,
      "$helperPid = [int]([IO.File]::ReadAllText((Join-Path $manifest.repository.root 'helper.pid')))",
      "Start-Sleep -Milliseconds 100",
      "$alive = $null -ne (Get-Process -Id $helperPid -ErrorAction SilentlyContinue)",
      "[ordered]@{ failure = $failure; alive = $alive } | ConvertTo-Json -Compress",
    ].join("\r\n"));

    expect(result).toEqual({ failure: "runtime-closure-invalid", alive: false });
  });

  it("kills and settles an interrupted runtime helper before returning its closed error", async () => {
    // Break caught: caller cancellation must close the same helper process
    // boundary as a deadline, rather than merely abandoning its observation.
    const root = await mkdtemp(join(tmpdir(), "intentarc-runtime-helper-interruption-"));
    temporaryRoots.push(root);
    const helper = join(root, "scripts", "release-runtime-closure.mjs");
    await mkdir(join(root, "scripts"), { recursive: true });
    await writeFile(helper, "import { writeFileSync } from 'node:fs'; import { join } from 'node:path'; writeFileSync(join(process.argv[3], 'helper.pid'), String(process.pid)); setInterval(() => {}, 1000);\n", "utf8");
    const nodeSha256 = createHash("sha256").update(await readFile(process.execPath)).digest("hex");
    const helperSha256 = createHash("sha256").update(await readFile(helper)).digest("hex");
    const result = await runControllerPowerShell([
      `$manifest = [pscustomobject]@{ repository = [pscustomobject]@{ root = '${escapePowerShell(root)}' }; release = [pscustomobject]@{ verifierExecutablePath = '${escapePowerShell(process.execPath)}'; verifierExecutableSha256 = '${nodeSha256}' } }`,
      "$cancellation = [Threading.CancellationTokenSource]::new()",
      "$cancellation.CancelAfter(250)",
      "$control = [pscustomobject]@{ cancellationToken = $cancellation.Token; deadlineUtc = [DateTime]::UtcNow.AddSeconds(2) }",
      `$failure = try { Invoke-IntentArcRuntimeClosureHelper -Manifest $manifest -ExpectedHelperSha256 '${helperSha256}' -Control $control | Out-Null; 'accepted' } catch { $_.Exception.Message } finally { $cancellation.Dispose() }`,
      "$helperPid = [int]([IO.File]::ReadAllText((Join-Path $manifest.repository.root 'helper.pid')))",
      "Start-Sleep -Milliseconds 100",
      "$alive = $null -ne (Get-Process -Id $helperPid -ErrorAction SilentlyContinue)",
      "[ordered]@{ failure = $failure; alive = $alive } | ConvertTo-Json -Compress",
    ].join("\r\n"));

    expect(result).toEqual({ failure: "runtime-closure-invalid", alive: false });
  });

  it("settles a runtime helper's spawned grandchild after the helper times out", async () => {
    // Break caught: PS 5.1's parent-only Process.Kill fallback leaves a helper
    // descendant alive after the controller returns its bounded refusal.
    const root = await mkdtemp(join(tmpdir(), "intentarc-runtime-helper-tree-"));
    temporaryRoots.push(root);
    const helper = join(root, "scripts", "release-runtime-closure.mjs");
    const grandchildPid = join(root, "grandchild.pid");
    await mkdir(join(root, "scripts"), { recursive: true });
    await writeFile(helper, `import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs'; import { join } from 'node:path'; const pidPath = join(process.argv[3], 'grandchild.pid'); const child = spawn(process.execPath, ['-e', "require('fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);", pidPath], { stdio: 'ignore', detached: true }); child.unref(); writeFileSync(join(process.argv[3], 'helper.pid'), String(process.pid)); setInterval(() => {}, 1000);\n`, "utf8");
    const nodeSha256 = createHash("sha256").update(await readFile(process.execPath)).digest("hex");
    const helperSha256 = createHash("sha256").update(await readFile(helper)).digest("hex");
    const result = await runControllerPowerShell([
      `$manifest = [pscustomobject]@{ repository = [pscustomobject]@{ root = '${escapePowerShell(root)}' }; release = [pscustomobject]@{ verifierExecutablePath = '${escapePowerShell(process.execPath)}'; verifierExecutableSha256 = '${nodeSha256}' } }`,
      "$control = [pscustomobject]@{ cancellationToken = [Threading.CancellationToken]::None; deadlineUtc = [DateTime]::UtcNow.AddMilliseconds(1500) }",
      `$failure = try { Invoke-IntentArcRuntimeClosureHelper -Manifest $manifest -ExpectedHelperSha256 '${helperSha256}' -Control $control | Out-Null; 'accepted' } catch { $_.Exception.Message }`,
      "$grandchild = [int]([IO.File]::ReadAllText((Join-Path $manifest.repository.root 'grandchild.pid')))",
      "Start-Sleep -Milliseconds 100",
      "$alive = $null -ne (Get-Process -Id $grandchild -ErrorAction SilentlyContinue)",
      "[ordered]@{ failure = $failure; grandchild = $grandchild; alive = $alive } | ConvertTo-Json -Compress",
    ].join("\r\n"));

    try {
      expect(result).toMatchObject({ failure: "runtime-closure-invalid", alive: false });
    } finally {
      if (result.alive) process.kill(result.grandchild);
    }
  });

  it("kills a live helper tree when initial descendant discovery fails", async () => {
    // Break caught: discovery failure must not bypass termination of the
    // already-bound root or abandon a descendant before closed refusal.
    const root = await mkdtemp(join(tmpdir(), "intentarc-discovery-failure-tree-"));
    temporaryRoots.push(root);
    const helper = join(root, "spawn-tree.mjs");
    const childPidPath = join(root, "child.pid");
    await writeFile(helper, [
      "import { spawn } from 'node:child_process';",
      "import { writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      "writeFileSync(join(process.argv[2], 'child.pid'), String(child.pid));",
      "setInterval(() => {}, 1000);",
    ].join("\n"), "utf8");
    const result = await runControllerPowerShell([
      `$process = Start-Process -FilePath '${escapePowerShell(process.execPath)}' -ArgumentList @('${escapePowerShell(helper)}','${escapePowerShell(root)}') -RedirectStandardOutput '${escapePowerShell(join(root, "helper.stdout"))}' -RedirectStandardError '${escapePowerShell(join(root, "helper.stderr"))}' -WindowStyle Hidden -PassThru`,
      `$childPidPath = '${escapePowerShell(childPidPath)}'`,
      "$deadline = [DateTime]::UtcNow.AddSeconds(3)",
      "while (-not [IO.File]::Exists($childPidPath) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 10 }",
      "if (-not [IO.File]::Exists($childPidPath)) { throw 'child-start' }",
      "$childPid = [int]([IO.File]::ReadAllText($childPidPath))",
      "$rootPid = $process.Id",
      "$originalObservation = ${function:Invoke-IntentArcBoundedPowerShellObservation}",
      "$calls = [pscustomobject]@{ Value = 0 }",
      "$observe = { param($Control); $calls.Value++; if ($calls.Value -eq 1) { throw 'injected-discovery' }; & $originalObservation -ScriptText 'Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId -OperationTimeoutSec 1 -ErrorAction Stop' -Control $Control }.GetNewClosure()",
      "$failure = try { Stop-IntentArcBoundProcessTree -Process $process -Observe $observe; 'accepted' } catch { $_.Exception.Message }",
      "Start-Sleep -Milliseconds 100",
      "$rootAlive = $null -ne (Get-Process -Id $rootPid -ErrorAction SilentlyContinue)",
      "$childAlive = $null -ne (Get-Process -Id $childPid -ErrorAction SilentlyContinue)",
      "if ($childAlive) { Stop-Process -Id $childPid -Force -ErrorAction SilentlyContinue }",
      "if ($rootAlive) { Stop-Process -Id $rootPid -Force -ErrorAction SilentlyContinue }",
      "Start-Sleep -Milliseconds 100",
      "[ordered]@{ failure = $failure; rootPid = $rootPid; childPid = $childPid; rootAlive = $rootAlive; childAlive = $childAlive; calls = $calls.Value } | ConvertTo-Json -Compress",
    ].join("\r\n"));

    expect(result).toMatchObject({
      failure: "bound-process-settlement",
      rootAlive: false,
      childAlive: false,
      calls: 2,
    });
  }, 30_000);

  it("surfaces runtime-helper settlement failure as a closed category", async () => {
    // Break caught: swallowing a failed tree settlement can dispose a helper
    // process whose liveness was never established as closed.
    const root = await mkdtemp(join(tmpdir(), "intentarc-runtime-helper-settlement-"));
    temporaryRoots.push(root);
    const helper = join(root, "scripts", "release-runtime-closure.mjs");
    await mkdir(join(root, "scripts"), { recursive: true });
    await writeFile(helper, "setInterval(() => {}, 1000);\n", "utf8");
    const nodeSha256 = createHash("sha256").update(await readFile(process.execPath)).digest("hex");
    const helperSha256 = createHash("sha256").update(await readFile(helper)).digest("hex");
    const result = await runControllerPowerShell([
      `$manifest = [pscustomobject]@{ repository = [pscustomobject]@{ root = '${escapePowerShell(root)}' }; release = [pscustomobject]@{ verifierExecutablePath = '${escapePowerShell(process.execPath)}'; verifierExecutableSha256 = '${nodeSha256}' } }`,
      "function Stop-IntentArcBoundProcessTree { param($Process) $Process.Kill(); throw 'bound-process-settlement' }",
      "$control = [pscustomobject]@{ cancellationToken = [Threading.CancellationToken]::None; deadlineUtc = [DateTime]::UtcNow.AddMilliseconds(250) }",
      `$failure = try { Invoke-IntentArcRuntimeClosureHelper -Manifest $manifest -ExpectedHelperSha256 '${helperSha256}' -Control $control | Out-Null; 'accepted' } catch { $_.Exception.Message }`,
      "$failure | ConvertTo-Json -Compress",
    ].join("\r\n"));

    expect(result).toBe("runtime-closure-settlement");
  });

  it("kills and settles a runtime helper whose output exceeds the observation cap", async () => {
    // Break caught: an output-limit refusal still has to terminate its helper;
    // otherwise the capped observation becomes a lingering process.
    const root = await mkdtemp(join(tmpdir(), "intentarc-runtime-helper-overflow-"));
    temporaryRoots.push(root);
    const helper = join(root, "scripts", "release-runtime-closure.mjs");
    await mkdir(join(root, "scripts"), { recursive: true });
    await writeFile(helper, "import { writeFileSync } from 'node:fs'; import { join } from 'node:path'; process.stdout.on('error', () => {}); writeFileSync(join(process.argv[3], 'helper.pid'), String(process.pid)); process.stdout.write('x'.repeat(65537)); setInterval(() => {}, 1000);\n", "utf8");
    const nodeSha256 = createHash("sha256").update(await readFile(process.execPath)).digest("hex");
    const helperSha256 = createHash("sha256").update(await readFile(helper)).digest("hex");
    const result = await runControllerPowerShell([
      `$manifest = [pscustomobject]@{ repository = [pscustomobject]@{ root = '${escapePowerShell(root)}' }; release = [pscustomobject]@{ verifierExecutablePath = '${escapePowerShell(process.execPath)}'; verifierExecutableSha256 = '${nodeSha256}' } }`,
      `$failure = try { Invoke-IntentArcRuntimeClosureHelper -Manifest $manifest -ExpectedHelperSha256 '${helperSha256}' | Out-Null; 'accepted' } catch { $_.Exception.Message }`,
      "$helperPid = [int]([IO.File]::ReadAllText((Join-Path $manifest.repository.root 'helper.pid')))",
      "Start-Sleep -Milliseconds 100",
      "$alive = $null -ne (Get-Process -Id $helperPid -ErrorAction SilentlyContinue)",
      "[ordered]@{ failure = $failure; alive = $alive } | ConvertTo-Json -Compress",
    ].join("\r\n"));

    expect(result).toEqual({ failure: "runtime-closure-invalid", alive: false });
  });

  it("artifact verifier process metadata is shell-free, exact, and never starts during construction", async () => {
    // Break caught: invoking the verifier through a shell, ambient Node, or a
    // command string would make successful evidence unrelated to authorization.
    const root = await mkdtemp(join(tmpdir(), "intentarc-verifier-process-"));
    temporaryRoots.push(root);
    const nodeExecutable = join(root, "node.exe");
    const verifierScript = join(root, "signed-artifact-bundle.mjs");
    const bundleRoot = join(root, "bundle.staging");
    const auditPath = join(root, "bridge-diagnostics.tokens");
    await writeFile(nodeExecutable, "not executed", "utf8");
    await writeFile(verifierScript, "not executed", "utf8");
    await mkdir(bundleRoot);
    await writeFile(auditPath, "identity\n", "utf8");
    const result = await runControllerPowerShell([
      "[Environment]::SetEnvironmentVariable('npm_config_userconfig', 'C:\\unsafe.npmrc', [EnvironmentVariableTarget]::Process)",
      "[Environment]::SetEnvironmentVariable('PNPM_HOME', 'C:\\unsafe-pnpm', [EnvironmentVariableTarget]::Process)",
      "[Environment]::SetEnvironmentVariable('NODE_OPTIONS', '--require unsafe.js', [EnvironmentVariableTarget]::Process)",
      "[Environment]::SetEnvironmentVariable('INTENTARC_WINDOWS_CERTIFICATE_PASSWORD', 'secret', [EnvironmentVariableTarget]::Process)",
      "[Environment]::SetEnvironmentVariable('INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_ROOT', 'C:\\ambient\\audit-root', [EnvironmentVariableTarget]::Process)",
      "[Environment]::SetEnvironmentVariable('INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_PATH', 'C:\\ambient\\audit-path.tokens', [EnvironmentVariableTarget]::Process)",
      `$startInfo = New-IntentArcVerifierProcessStartInfo -Executable '${escapePowerShell(nodeExecutable)}' -ScriptPath '${escapePowerShell(verifierScript)}' -BundleRoot '${escapePowerShell(bundleRoot)}' -ExpectedThumbprint '${"A".repeat(40)}' -WorkingDirectory '${escapePowerShell(root)}' -AuditRoot '${escapePowerShell(root)}' -AuditPath '${escapePowerShell(auditPath)}'`,
      `$invalidAudit = try { [void](New-IntentArcVerifierProcessStartInfo -Executable '${escapePowerShell(nodeExecutable)}' -ScriptPath '${escapePowerShell(verifierScript)}' -BundleRoot '${escapePowerShell(bundleRoot)}' -ExpectedThumbprint '${"A".repeat(40)}' -WorkingDirectory '${escapePowerShell(root)}' -AuditRoot '${escapePowerShell(root)}' -AuditPath '${escapePowerShell(join(root, "caller.tokens"))}'); 'accepted' } catch { $_.Exception.Message }`,
      "$keys = @($startInfo.EnvironmentVariables.Keys | ForEach-Object { [string]$_ } | Sort-Object)",
      "[ordered]@{ fileName = $startInfo.FileName; arguments = $startInfo.Arguments; workingDirectory = $startInfo.WorkingDirectory; useShellExecute = $startInfo.UseShellExecute; redirectStandardOutput = $startInfo.RedirectStandardOutput; redirectStandardError = $startInfo.RedirectStandardError; keys = $keys; pathExt = $startInfo.EnvironmentVariables['PATHEXT']; auditRoot = $startInfo.EnvironmentVariables['INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_ROOT']; auditPath = $startInfo.EnvironmentVariables['INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_PATH']; invalidAudit = $invalidAudit } | ConvertTo-Json -Compress",
    ].join("\r\n"));

    expect(result).toEqual({
      fileName: nodeExecutable,
      arguments: `"${verifierScript}" verify --bundle "${bundleRoot}" --expected-thumbprint ${"A".repeat(40)}`,
      workingDirectory: root,
      useShellExecute: false,
      redirectStandardOutput: true,
      redirectStandardError: true,
      keys: [
        "INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_PATH",
        "INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_ROOT",
        "PATH", "PATHEXT", "SystemRoot", "TEMP", "TMP", "USERPROFILE", "WINDIR",
      ],
      pathExt: ".COM;.EXE",
      auditRoot: root,
      auditPath,
      invalidAudit: "bridge-diagnostic-audit",
    });
  });

  it("constructs an isolated no-shell bound Git status process", async () => {
    // Break caught: invoking Git through PowerShell or inheriting its process
    // configuration allows optional integrations to run before the marker.
    const root = await mkdtemp(join(tmpdir(), "intentarc-bound-git-"));
    temporaryRoots.push(root);
    const git = join(root, "git.exe");
    await writeFile(git, "not executed", "utf8");
    const result = await runControllerPowerShell([
      `$startInfo = New-IntentArcBoundGitProcessStartInfo -Executable '${escapePowerShell(git)}' -RepositoryRoot '${escapePowerShell(root)}' -Command 'status'`,
      "$keys = @($startInfo.EnvironmentVariables.Keys | ForEach-Object { [string]$_ } | Sort-Object)",
      "[ordered]@{ fileName = $startInfo.FileName; arguments = $startInfo.Arguments; workingDirectory = $startInfo.WorkingDirectory; useShellExecute = $startInfo.UseShellExecute; redirectStandardOutput = $startInfo.RedirectStandardOutput; redirectStandardError = $startInfo.RedirectStandardError; keys = $keys } | ConvertTo-Json -Compress",
    ].join("\r\n"));

    expect(result).toEqual({
      fileName: git,
      arguments: `--no-optional-locks -c core.fsmonitor=false -c core.quotePath=false -C "${root}" status --porcelain=v1 --untracked-files=no`,
      workingDirectory: root,
      useShellExecute: false,
      redirectStandardOutput: true,
      redirectStandardError: true,
      keys: ["SystemRoot", "TEMP", "TMP", "WINDIR"],
    });
  });

  it("runs the bound Git observations with poisoned ambient Git configuration absent", async () => {
    // Break caught: inherited Git configuration or PATH can execute an
    // integration before the marker even when the manifest binds git.exe.
    const git = "C:\\Program Files\\Git\\cmd\\git.exe";
    const gitSha256 = createHash("sha256").update(await readFile(git)).digest("hex");
    const poisonRoot = await mkdtemp(join(tmpdir(), "intentarc-git-poison-"));
    temporaryRoots.push(poisonRoot);
    const poisonConfig = join(poisonRoot, "gitconfig");
    await writeFile(poisonConfig, "[core]\nfsmonitor = C:/missing/hostile-fsmonitor.exe\n", "utf8");
    const result = await runControllerPowerShell([
      `[Environment]::SetEnvironmentVariable('GIT_CONFIG_GLOBAL', '${escapePowerShell(poisonConfig)}', [EnvironmentVariableTarget]::Process)`,
      "[Environment]::SetEnvironmentVariable('PATH', 'C:\\ambient-poison', [EnvironmentVariableTarget]::Process)",
      `$status = Invoke-IntentArcBoundGit -Executable '${escapePowerShell(git)}' -RepositoryRoot '${escapePowerShell(process.cwd())}' -Command status -ExpectedSha256 '${gitSha256}'`,
      `$commit = Invoke-IntentArcBoundGit -Executable '${escapePowerShell(git)}' -RepositoryRoot '${escapePowerShell(process.cwd())}' -Command commit -ExpectedSha256 '${gitSha256}'`,
      "[ordered]@{ statusBytes = [Text.UTF8Encoding]::new($false).GetByteCount($status); commit = $commit.Trim() } | ConvertTo-Json -Compress",
    ].join("\r\n"));

    expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(result.statusBytes).toBeGreaterThanOrEqual(0);
    expect(result.statusBytes).toBeLessThan(1024);
  });

  it("surfaces bound Git settlement failure as a closed category", async () => {
    // Break caught: suppressing a failed Git tree settlement can return a
    // generic refusal after the process boundary has not been proved closed.
    const git = "C:\\Program Files\\Git\\cmd\\git.exe";
    const gitSha256 = createHash("sha256").update(await readFile(git)).digest("hex");
    const result = await runControllerPowerShell([
      "function Receive-IntentArcBoundedProcessOutput { throw 'timeout' }",
      "function Stop-IntentArcBoundProcessTree { param($Process) $Process.Kill(); throw 'bound-process-settlement' }",
      `$failure = try { Invoke-IntentArcBoundGit -Executable '${escapePowerShell(git)}' -RepositoryRoot '${escapePowerShell(process.cwd())}' -Command status -ExpectedSha256 '${gitSha256}' | Out-Null; 'accepted' } catch { $_.Exception.Message }`,
      "$failure | ConvertTo-Json -Compress",
    ].join("\r\n"));

    expect(result).toBe("bound-git-settlement");
  });

  it("accepts only closed verifier evidence bound to the authorized release", async () => {
    // Break caught: a successful exit with unrelated, partial, or attacker-
    // extended JSON must not become signature/predecessor/bundle claims.
    const thumbprint = "A".repeat(40);
    const commit = "b".repeat(40);
    const verifierSha256 = "c".repeat(64);
    const evidence = {
      bridgeDiagnosticInvocationCount: 5,
      bridgeNativeVerified: true,
      bundleClosureVerified: true,
      bundleId: runId,
      fileCount: 7,
      packageVersion: "1.2.3",
      publisher: {
        cerSha256: "d".repeat(64),
        subject: "CN=IntentArc Release",
        thumbprint,
      },
      releaseExecutablesVerified: true,
      schemaVersion: 1,
      sourceCommit: commit,
      totalBytes: 1234,
      verifierSha256,
    };
    const run = (value: unknown) => runControllerPowerShell([
      `$json = @'\r\n${JSON.stringify(value)}\r\n'@`,
      `$result = ConvertFrom-IntentArcArtifactVerifierEvidence -Json $json -ExpectedBundleId '${runId}' -ExpectedCommit '${commit}' -ExpectedThumbprint '${thumbprint}' -ExpectedVerifierSha256 '${verifierSha256}'`,
      "$result | ConvertTo-Json -Depth 6 -Compress",
    ].join("\r\n"));

    await expect(run(evidence)).resolves.toEqual({
      signatureVerified: true,
      bridgePredecessorVerified: true,
      artifactVerified: true,
      bridgeDiagnosticInvocationCount: 5,
      fileCount: 7,
      totalBytes: 1234,
    });
    await expect(run({ ...evidence, bridgeDiagnosticInvocationCount: 0 })).resolves.toMatchObject({
      bridgeDiagnosticInvocationCount: 0,
    });
    const { bridgeDiagnosticInvocationCount: _missingCount, ...missingCount } = evidence;
    await expect(run(missingCount)).rejects.toThrow("artifact-verifier-evidence-invalid");
    for (const invalidCount of ["5", true, false, 1.5, -1, 1, 2, 3, 4, 6, 2147483648]) {
      await expect(run({
        ...evidence,
        bridgeDiagnosticInvocationCount: invalidCount,
      })).rejects.toThrow("artifact-verifier-evidence-invalid");
    }
    await expect(run({ ...evidence, injected: true })).rejects.toThrow("artifact-verifier-evidence-invalid");
    await expect(run({ ...evidence, bundleId: "intentarc-phase1-signed-20260830-02" })).rejects.toThrow("artifact-verifier-evidence-invalid");
    await expect(run({ ...evidence, sourceCommit: "e".repeat(40) })).rejects.toThrow("artifact-verifier-evidence-invalid");
    await expect(run({ ...evidence, bundleClosureVerified: false })).rejects.toThrow("artifact-verifier-evidence-invalid");
    await expect(run({ ...evidence, packageVersion: "1.2.3-trailing" })).rejects.toThrow("artifact-verifier-evidence-invalid");
  }, 30_000);

  it("production residue probing treats an unknown retained CNG identity as absent without discovery", async () => {
    // Break caught: attempting CngKey.Exists with a null partial-preparation
    // identity turns a contained certificate failure into after-projection failure.
    const result = await runControllerPowerShell([
      "$calls = [pscustomobject]@{ Value = 0 }",
      "$exists = { $calls.Value++; throw 'unexpected discovery' }.GetNewClosure()",
      "$count = Get-IntentArcRecordedCngKeyResidueCount -KeyIdentifier $null -Exists $exists",
      "[ordered]@{ count = $count; calls = $calls.Value } | ConvertTo-Json -Compress",
    ].join("\r\n"));

    expect(result).toEqual({ count: 0, calls: 0 });
  });

  it("real certificate wrappers recover cleanup identity after a native create mutate-then-throw", async () => {
    // Break caught: wrapper state written only after an exporter returns loses
    // the exact PFX/CER cleanup target when the exporter mutates then throws.
    const root = await mkdtemp(join(tmpdir(), "intentarc-certificate-wrapper-"));
    temporaryRoots.push(root);
    const pfx = join(root, "private.pfx");
    const cer = join(root, "public.cer");
    const result = await runControllerPowerShell([
      `$manifest = [pscustomobject]@{ certificate = [pscustomobject]@{ keyContainerName = 'IntentArc.Release.Static-Test' } }`,
      `$preparation = [ordered]@{ thumbprint = $null; keyIdentifier = $null; pfxPath = $null; cerPath = $null }`,
      `$state = [pscustomobject]@{ Certificate = $null; KeyIdentifier = $null; PfxPath = $null; CerPath = $null }`,
      " $createdCertificate = [pscustomobject]@{ Thumbprint = 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC'; Subject = 'CN=Static' }",
      " $storeRecords = New-Object Collections.ArrayList",
      "$commands = @{",
      " 'certificate-create' = { param($Subject,$Store,$Key,$CreationState); [void]$storeRecords.Add($createdCertificate); throw 'mutated-create' }.GetNewClosure()",
      " 'private-key-open' = { param($Certificate); $true }",
      " 'certificate-export' = { param($Certificate,$Path,$Password); [IO.File]::WriteAllText($Path,'partial'); throw 'mutated-pfx' }",
      " 'public-certificate-export' = { param($Certificate,$Path); [IO.File]::WriteAllText($Path,'partial'); throw 'mutated-cer' }",
      " 'thumbprint-verify' = { param($Certificate,$Path); $true }",
      "}",
      "$find = { param($Subject,$Store,$Key); @($storeRecords | Where-Object { $_.Subject -ceq $Subject }) }.GetNewClosure()",
      `$wrapped = New-IntentArcCertificatePreparationCommands -Manifest $manifest -PreparationState $preparation -OperationState $state -InnerCommands $commands -RunRoot '${escapePowerShell(root)}' -FindCreatedCertificate $find`,
      "try { & $wrapped['certificate-create'] 'CN=Static' 'Cert:\\CurrentUser\\My' 'IntentArc.Release.Static-Test' } catch { }",
      `$password = [Activator]::CreateInstance([Security.SecureString])`,
      `try { & $wrapped['certificate-export'] $null '${escapePowerShell(pfx)}' $password } catch { }`,
      `try { & $wrapped['public-certificate-export'] $null '${escapePowerShell(cer)}' } catch { }`,
      "[ordered]@{ key = $preparation.keyIdentifier; stateKey = $state.KeyIdentifier; thumbprint = $preparation.thumbprint; stateThumbprint = $state.Certificate.Thumbprint; pfx = $preparation.pfxPath; statePfx = $state.PfxPath; cer = $preparation.cerPath; stateCer = $state.CerPath; pfxExists = [IO.File]::Exists($preparation.pfxPath); cerExists = [IO.File]::Exists($preparation.cerPath) } | ConvertTo-Json -Compress",
    ].join("\r\n"));

    expect(result).toEqual({
      key: "IntentArc.Release.Static-Test",
      stateKey: "IntentArc.Release.Static-Test",
      thumbprint: "C".repeat(40),
      stateThumbprint: "C".repeat(40),
      pfx,
      statePfx: pfx,
      cer,
      stateCer: cer,
      pfxExists: true,
      cerExists: true,
    });
  });

  it.each([0, 2])("does not invent certificate identity from %i recovery candidates", async (candidateCount) => {
    const root = await mkdtemp(join(tmpdir(), "intentarc-certificate-recovery-"));
    temporaryRoots.push(root);
    const result = await runControllerPowerShell([
      "$manifest = [pscustomobject]@{ certificate = [pscustomobject]@{ keyContainerName = 'IntentArc.Release.Static-Test' } }",
      "$preparation = [ordered]@{ thumbprint = $null; keyIdentifier = $null; pfxPath = $null; cerPath = $null }",
      "$state = [pscustomobject]@{ Certificate = $null; KeyIdentifier = $null; PfxPath = $null; CerPath = $null }",
      "$commands = @{ 'certificate-create' = { throw 'native-create-failed' }; 'private-key-open' = { $true }; 'certificate-export' = { $true }; 'public-certificate-export' = { $true }; 'thumbprint-verify' = { $true } }",
      `$find = { ${candidateCount === 0 ? "@()" : "1..2 | ForEach-Object { [pscustomobject]@{ Thumbprint = ('D' * 40); Subject = 'CN=Static' } }"} }`,
      `$wrapped = New-IntentArcCertificatePreparationCommands -Manifest $manifest -PreparationState $preparation -OperationState $state -InnerCommands $commands -RunRoot '${escapePowerShell(root)}' -FindCreatedCertificate $find`,
      "$failure = try { & $wrapped['certificate-create'] 'CN=Static' 'Cert:\\CurrentUser\\My' 'IntentArc.Release.Static-Test'; 'unexpected' } catch { $_.Exception.Message }",
      "[ordered]@{ failure = $failure; thumbprint = $preparation.thumbprint; certificatePresent = ($null -ne $state.Certificate); key = $preparation.keyIdentifier } | ConvertTo-Json -Compress",
    ].join("\r\n"));

    expect(result).toEqual({
      failure: "native-create-failed",
      thumbprint: null,
      certificatePresent: false,
      key: "IntentArc.Release.Static-Test",
    });
  });

  it("copies and removes exact trees without recursive cmdlets", async () => {
    const root = await mkdtemp(join(tmpdir(), "intentarc-exact-tree-"));
    temporaryRoots.push(root);
    const source = join(root, "source");
    const destinationRoot = join(root, "destination-root");
    const destination = join(destinationRoot, "copied");
    await mkdir(join(source, "nested"), { recursive: true });
    await mkdir(destinationRoot);
    await writeFile(join(source, "nested", "payload.bin"), "payload", "utf8");
    const result = await runControllerPowerShell([
      `Copy-IntentArcExactTree -LiteralSourceRoot '${escapePowerShell(root)}' -LiteralSource '${escapePowerShell(source)}' -LiteralDestinationRoot '${escapePowerShell(destinationRoot)}' -LiteralDestination '${escapePowerShell(destination)}'`,
      `$copied = [IO.File]::ReadAllText('${escapePowerShell(join(destination, "nested", "payload.bin"))}')`,
      `Remove-IntentArcExactTree -LiteralRoot '${escapePowerShell(destinationRoot)}' -LiteralPath '${escapePowerShell(destination)}'`,
      `[ordered]@{ copied = $copied; remains = ([IO.File]::Exists('${escapePowerShell(destination)}') -or [IO.Directory]::Exists('${escapePowerShell(destination)}')) } | ConvertTo-Json -Compress`,
    ].join("\r\n"));

    expect(result).toEqual({ copied: "payload", remains: false });
  });

  it("refuses nested reparse entries during exact tree copy", async () => {
    const root = await mkdtemp(join(tmpdir(), "intentarc-exact-tree-reparse-"));
    temporaryRoots.push(root);
    const source = join(root, "source");
    const outside = join(root, "outside");
    const destinationRoot = join(root, "destination-root");
    const destination = join(destinationRoot, "copied");
    await mkdir(source);
    await mkdir(outside);
    await mkdir(destinationRoot);
    await writeFile(join(outside, "escaped.txt"), "forbidden", "utf8");
    await symlink(outside, join(source, "escape"), "junction");

    await expect(runControllerPowerShell(
      `Copy-IntentArcExactTree -LiteralSourceRoot '${escapePowerShell(root)}' -LiteralSource '${escapePowerShell(source)}' -LiteralDestinationRoot '${escapePowerShell(destinationRoot)}' -LiteralDestination '${escapePowerShell(destination)}'`,
    )).rejects.toThrow(/reparse|cleanup-target/i);
    await expect(readFile(join(destination, "escape", "escaped.txt"), "utf8")).rejects.toThrow();
  });

  it("production descendant settlement counts any surviving recorded process identity", async () => {
    // Break caught: swallowing a failed exact-PID kill and unconditionally
    // reporting zero would let cleanup claim a false settlement proof.
    const result = await runControllerPowerShell([
      "$active = { param($Id); return ($Id -eq 12) }",
      "$count = Get-IntentArcActiveRecordedProcessCount -ProcessIds @(11, 12) -IsActive $active",
      "[ordered]@{ count = $count } | ConvertTo-Json -Compress",
    ].join("\r\n"));

    expect(result).toEqual({ count: 1 });
  });

  it.each(["stdout", "stderr"] as const)("bounds redirected %s without an unbounded line or whole-stream read", async (streamName) => {
    const result = await runControllerPowerShell([
      "$bytes = New-Object byte[] 65537",
      "$stdout = if ('" + streamName + "' -ceq 'stdout') { [IO.MemoryStream]::new($bytes) } else { [IO.MemoryStream]::new() }",
      "$stderr = if ('" + streamName + "' -ceq 'stderr') { [IO.MemoryStream]::new($bytes) } else { [IO.MemoryStream]::new() }",
      "$control = [pscustomobject]@{ cancellationToken = [Threading.CancellationToken]::None; deadlineUtc = [DateTime]::UtcNow.AddSeconds(2) }",
      "$(try { [void](Receive-IntentArcBoundedProcessOutput -StandardOutput $stdout -StandardError $stderr -Control $control); 'unexpected' } catch { $_.Exception.Message }) | ConvertTo-Json -Compress",
    ].join("\r\n"));

    expect(result).toBe("process-output-limit");
  });

  it("bounds a hung redirected stream by the shared deadline", async () => {
    const started = Date.now();
    const result = await runControllerPowerShell([
      "$source = [IO.MemoryStream]::new()",
      "$pending = [Threading.Tasks.TaskCompletionSource[int]]::new()",
      "$beginRead = { param($Stream,$Buffer); $pending.Task }.GetNewClosure()",
      "$control = [pscustomobject]@{ cancellationToken = [Threading.CancellationToken]::None; deadlineUtc = [DateTime]::UtcNow.AddMilliseconds(100) }",
      "$(try { [void](Receive-IntentArcBoundedProcessOutput -StandardOutput $source -StandardError $source -Control $control -BeginRead $beginRead); 'unexpected' } catch { $_.Exception.Message }) | ConvertTo-Json -Compress",
    ].join("\r\n"));

    expect(result).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it.each(["interruption", "timeout"] as const)("preserves verifier %s through bounded I/O cleanup", async (category) => {
    const result = await runControllerPowerShell([
      "$source = [IO.MemoryStream]::new()",
      "$pending = [Threading.Tasks.TaskCompletionSource[int]]::new()",
      "$beginRead = { param($Stream,$Buffer); $pending.Task }.GetNewClosure()",
      "$kills = [pscustomobject]@{ Value = 0 }; $kill = { $kills.Value++ }.GetNewClosure()",
      "$tokenSource = [Threading.CancellationTokenSource]::new()",
      ...(category === "interruption" ? ["$tokenSource.Cancel()"] : []),
      `$control = [pscustomobject]@{ cancellationToken = $tokenSource.Token; deadlineUtc = [DateTime]::UtcNow.${category === "timeout" ? "AddMilliseconds(-1)" : "AddSeconds(2)"} }`,
      "$failure = try { [void](Receive-IntentArcVerifierOutputBoundary -StandardOutput $source -StandardError $source -Control $control -Kill $kill -BeginRead $beginRead); 'unexpected' } catch { $_.Exception.Message }",
      "[ordered]@{ failure = $failure; kills = $kills.Value } | ConvertTo-Json -Compress",
    ].join("\r\n"));

    expect(result).toEqual({ failure: category, kills: 1 });
  });

  it("surfaces verifier tree-settlement failure instead of suppressing it", async () => {
    // Break caught: a verifier output failure must not conceal a failed
    // descendant settlement behind the original timeout category.
    const result = await runControllerPowerShell([
      "$source = [IO.MemoryStream]::new()",
      "$pending = [Threading.Tasks.TaskCompletionSource[int]]::new()",
      "$beginRead = { param($Stream,$Buffer); $pending.Task }.GetNewClosure()",
      "$kill = { throw 'bound-process-settlement' }.GetNewClosure()",
      "$control = [pscustomobject]@{ cancellationToken = [Threading.CancellationToken]::None; deadlineUtc = [DateTime]::UtcNow.AddMilliseconds(-1) }",
      "$failure = try { [void](Receive-IntentArcVerifierOutputBoundary -StandardOutput $source -StandardError $source -Control $control -Kill $kill -BeginRead $beginRead); 'unexpected' } catch { $_.Exception.Message }",
      "$failure | ConvertTo-Json -Compress",
    ].join("\r\n"));

    expect(result).toBe("artifact-verifier-settlement");
  });

  it("maps only genuine verifier I/O failure to artifact-verification", async () => {
    const result = await runControllerPowerShell([
      "$source = [IO.MemoryStream]::new()",
      "$beginRead = { param($Stream,$Buffer); 'not-a-task' }",
      "$kills = [pscustomobject]@{ Value = 0 }; $kill = { $kills.Value++ }.GetNewClosure()",
      "$control = [pscustomobject]@{ cancellationToken = [Threading.CancellationToken]::None; deadlineUtc = [DateTime]::UtcNow.AddSeconds(2) }",
      "$failure = try { [void](Receive-IntentArcVerifierOutputBoundary -StandardOutput $source -StandardError $source -Control $control -Kill $kill -BeginRead $beginRead); 'unexpected' } catch { $_.Exception.Message }",
      "[ordered]@{ failure = $failure; kills = $kills.Value } | ConvertTo-Json -Compress",
    ].join("\r\n"));

    expect(result).toEqual({ failure: "artifact-verification", kills: 1 });
  });

  it("final process projection distinguishes a surviving identity from PID reuse", async () => {
    // Break caught: counting a reused PID as owned can target an unrelated
    // process, while counting every recorded PID as exited can hide a survivor.
    const result = await runControllerPowerShell([
      "$identities = @{ '11' = [long]100; '12' = [long]200 }",
      "$same = { param($Id, $Ticks); return ($Id -eq 12 -and $Ticks -eq 200) }",
      "$count = Get-IntentArcActiveRecordedProcessIdentityCount -ProcessIdentities $identities -IsSameActiveProcess $same",
      "[ordered]@{ count = $count } | ConvertTo-Json -Compress",
    ].join("\r\n"));

    expect(result).toEqual({ count: 1 });
  });

  it("descendant discovery never seeds a reused root but extends recorded live descendants", async () => {
    const result = await runControllerPowerShell([
      "$rows = @([pscustomobject]@{ ProcessId = 10; ParentProcessId = 1 }, [pscustomobject]@{ ProcessId = 20; ParentProcessId = 10 }, [pscustomobject]@{ ProcessId = 30; ParentProcessId = 20 })",
      "$snapshot = { $rows }.GetNewClosure()",
      "$ticks = { param($Id); switch ($Id) { 10 { [long]999 }; 20 { [long]200 }; 30 { [long]300 } } }.GetNewClosure()",
      "$reusedOnly = @{ '10' = [long]100 }",
      "Update-IntentArcRecordedProcessIdentities -ProcessIdentities $reusedOnly -Snapshot $snapshot -GetStartTicks $ticks",
      "$accumulated = @{ '10' = [long]100; '20' = [long]200 }",
      "Update-IntentArcRecordedProcessIdentities -ProcessIdentities $accumulated -Snapshot $snapshot -GetStartTicks $ticks",
      "[ordered]@{ reusedKeys = @($reusedOnly.Keys | Sort-Object); accumulatedKeys = @($accumulated.Keys | Sort-Object) } | ConvertTo-Json -Compress",
    ].join("\r\n"));

    expect(result).toEqual({ reusedKeys: ["10"], accumulatedKeys: ["10", "20", "30"] });
  });

  it("bounds a hung production-style descendant observation", async () => {
    const started = Date.now();
    const result = await runControllerPowerShell([
      "$control = [pscustomobject]@{ cancellationToken = [Threading.CancellationToken]::None; deadlineUtc = [DateTime]::UtcNow.AddMilliseconds(150) }",
      "$(try { [void](Invoke-IntentArcBoundedPowerShellObservation -ScriptText 'Start-Sleep -Seconds 30' -Control $control); 'unexpected' } catch { $_.Exception.Message }) | ConvertTo-Json -Compress",
    ].join("\r\n"));

    expect(result).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(2500);
  });

  it("caps descendant graph work and honors cancellation before enumeration", async () => {
    const result = await runControllerPowerShell([
      "$rows = 1..300 | ForEach-Object { [pscustomobject]@{ ProcessId = ($_ + 10); ParentProcessId = 10 } }",
      "$snapshot = { $rows }.GetNewClosure()",
      "$ticks = { param($Id); [long]($Id + 100) }",
      "$active = [pscustomobject]@{ cancellationToken = [Threading.CancellationToken]::None; deadlineUtc = [DateTime]::UtcNow.AddSeconds(2) }",
      "$cancelledSource = [Threading.CancellationTokenSource]::new(); $cancelledSource.Cancel()",
      "$cancelled = [pscustomobject]@{ cancellationToken = $cancelledSource.Token; deadlineUtc = [DateTime]::UtcNow.AddSeconds(2) }",
      "$many = try { $ids = @{ '10' = [long]110 }; Update-IntentArcRecordedProcessIdentities -ProcessIdentities $ids -Snapshot $snapshot -GetStartTicks $ticks -Control $active; 'unexpected' } catch { $_.Exception.Message }",
      "$cancel = try { $ids = @{ '10' = [long]110 }; Update-IntentArcRecordedProcessIdentities -ProcessIdentities $ids -Snapshot $snapshot -GetStartTicks $ticks -Control $cancelled; 'unexpected' } catch { $_.Exception.Message }",
      "[ordered]@{ many = $many; cancel = $cancel } | ConvertTo-Json -Compress",
    ].join("\r\n"));

    expect(result).toEqual({ many: "descendant-discovery", cancel: "interruption" });
  });

  it("accepts a realistic full process snapshot while retaining a separate identity cap", async () => {
    const result = await runControllerPowerShell([
      "$rows = 1..262 | ForEach-Object { [pscustomobject]@{ ProcessId = ($_ + 1000); ParentProcessId = 1 } }",
      "$rows[0].ParentProcessId = 0",
      "$snapshot = { $rows }.GetNewClosure()",
      "$ticks = { param($Id); [long]($Id + 10000) }",
      "$control = [pscustomobject]@{ cancellationToken = [Threading.CancellationToken]::None; deadlineUtc = [DateTime]::UtcNow.AddSeconds(2) }",
      "$ids = @{ ([string]$rows[0].ProcessId) = [long]($rows[0].ProcessId + 10000) }",
      "Update-IntentArcRecordedProcessIdentities -ProcessIdentities $ids -Snapshot $snapshot -GetStartTicks $ticks -Control $control",
      "[ordered]@{ rows = $rows.Count; identities = $ids.Count } | ConvertTo-Json -Compress",
    ].join("\r\n"));

    expect(result).toEqual({ rows: 262, identities: 1 });
  });

  it("allows the current host process snapshot but caps full snapshots and retained identities separately", async () => {
    const result = await runControllerPowerShell([
      "$control = [pscustomobject]@{ cancellationToken = [Threading.CancellationToken]::None; deadlineUtc = [DateTime]::UtcNow.AddSeconds(3) }",
      "$current = @(Invoke-IntentArcBoundedPowerShellObservation -ScriptText 'Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId -OperationTimeoutSec 1 -ErrorAction Stop' -Control $control)",
      "$tooManyRows = 1..4097 | ForEach-Object { [pscustomobject]@{ ProcessId = $_; ParentProcessId = 0 } }",
      "$snapshot = { $tooManyRows }.GetNewClosure()",
      "$ticks = { param($Id); [long]$Id }",
      "$snapshotFailure = try { $ids = @{ '1' = [long]1 }; Update-IntentArcRecordedProcessIdentities -ProcessIdentities $ids -Snapshot $snapshot -GetStartTicks $ticks -Control $control; 'unexpected' } catch { $_.Exception.Message }",
      "$tooManyIdentities = @{}; 1..257 | ForEach-Object { $tooManyIdentities[[string]$_] = [long]$_ }",
      "$identityFailure = try { Update-IntentArcRecordedProcessIdentities -ProcessIdentities $tooManyIdentities -Snapshot { @() } -GetStartTicks $ticks -Control $control; 'unexpected' } catch { $_.Exception.Message }",
      "[ordered]@{ currentCount = $current.Count; snapshotFailure = $snapshotFailure; identityFailure = $identityFailure } | ConvertTo-Json -Compress",
    ].join("\r\n"));

    expect(result.currentCount).toBeGreaterThan(0);
    expect(result.currentCount).toBeLessThanOrEqual(4096);
    expect(result.snapshotFailure).toBe("descendant-discovery");
    expect(result.identityFailure).toBe("descendant-discovery");
  });

  it("disposes bounded observation runspaces after repeated timeout", async () => {
    const result = await runControllerPowerShell([
      "$before = @(Get-Runspace).Count",
      "1..3 | ForEach-Object {",
      "  $control = [pscustomobject]@{ cancellationToken = [Threading.CancellationToken]::None; deadlineUtc = [DateTime]::UtcNow.AddMilliseconds(75) }",
      "  try { [void](Invoke-IntentArcBoundedPowerShellObservation -ScriptText 'Start-Sleep -Seconds 30' -Control $control) } catch { if ($_.Exception.Message -cne 'timeout') { throw } }",
      "}",
      "Start-Sleep -Milliseconds 100",
      "$after = @(Get-Runspace).Count",
      "[ordered]@{ before = $before; after = $after } | ConvertTo-Json -Compress",
    ].join("\r\n"));

    expect(result.after).toBe(result.before);
  });

  it("disposes bounded observation runspaces after repeated pipeline errors", async () => {
    const result = await runControllerPowerShell([
      "$before = @(Get-Runspace).Count",
      "1..3 | ForEach-Object {",
      "  $control = [pscustomobject]@{ cancellationToken = [Threading.CancellationToken]::None; deadlineUtc = [DateTime]::UtcNow.AddSeconds(2) }",
      "  try { [void](Invoke-IntentArcBoundedPowerShellObservation -ScriptText \"throw 'observation-error'\" -Control $control) } catch { }",
      "}",
      "$after = @(Get-Runspace).Count",
      "[ordered]@{ before = $before; after = $after } | ConvertTo-Json -Compress",
    ].join("\r\n"));

    expect(result.after).toBe(result.before);
  });

  it("settles and disposes a non-cooperative observation within the declared cleanup ceiling", async () => {
    const started = Date.now();
    const result = await runControllerPowerShell([
      "$before = @(Get-Runspace).Count",
      "$control = [pscustomobject]@{ cancellationToken = [Threading.CancellationToken]::None; deadlineUtc = [DateTime]::UtcNow.AddMilliseconds(50) }",
      "$failure = try { [void](Invoke-IntentArcBoundedPowerShellObservation -ScriptText '[Threading.Thread]::Sleep(2500)' -Control $control); 'unexpected' } catch { $_.Exception.Message }",
      "$afterReturn = @(Get-Runspace).Count",
      "Start-Sleep -Milliseconds 1700",
      "$afterNaturalCompletion = @(Get-Runspace).Count",
      "[ordered]@{ before = $before; afterReturn = $afterReturn; afterNaturalCompletion = $afterNaturalCompletion; failure = $failure } | ConvertTo-Json -Compress",
    ].join("\r\n"));

    expect(result).toEqual({
      before: 1,
      afterReturn: 1,
      afterNaturalCompletion: 1,
      failure: "timeout",
    });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("does not accumulate runspaces across repeated non-cooperative observations", async () => {
    const result = await runControllerPowerShell([
      "$before = @(Get-Runspace).Count",
      "$failures = @()",
      "1..2 | ForEach-Object {",
      "  $control = [pscustomobject]@{ cancellationToken = [Threading.CancellationToken]::None; deadlineUtc = [DateTime]::UtcNow.AddMilliseconds(25) }",
      "  try { [void](Invoke-IntentArcBoundedPowerShellObservation -ScriptText '[Threading.Thread]::Sleep(1250)' -Control $control) } catch { $failures += $_.Exception.Message }",
      "}",
      "$after = @(Get-Runspace).Count",
      "[ordered]@{ before = $before; after = $after; failures = $failures } | ConvertTo-Json -Compress",
    ].join("\r\n"));

    expect(result).toEqual({ before: 1, after: 1, failures: ["timeout", "timeout"] });
  });

  it("disposes the observation object even when completed stop finalization throws", async () => {
    const result = await runControllerPowerShell([
      "class IntentArcCompletedAsyncResult {",
      "  [bool] $IsCompleted",
      "  IntentArcCompletedAsyncResult([bool] $IsCompleted) { $this.IsCompleted = $IsCompleted }",
      "}",
      "class IntentArcEndStopThrowingPowerShell {",
      "  static [int] $DisposeCalls = 0",
      "  [bool] $HadErrors = $false",
      "  [object] AddScript([string] $ScriptText) { return $this }",
      "  [object] BeginInvoke() { return [IntentArcCompletedAsyncResult]::new($false) }",
      "  [object] BeginStop([object] $Callback, [object] $State) { return [IntentArcCompletedAsyncResult]::new($true) }",
      "  [void] EndStop([object] $AsyncResult) { throw 'stop-finalization' }",
      "  [void] Dispose() { [IntentArcEndStopThrowingPowerShell]::DisposeCalls++ }",
      "}",
      "$factory = { [IntentArcEndStopThrowingPowerShell]::new() }",
      "$control = [pscustomobject]@{ cancellationToken = [Threading.CancellationToken]::None; deadlineUtc = [DateTime]::UtcNow.AddSeconds(2) }",
      "$failure = try { [void](Invoke-IntentArcBoundedPowerShellObservation -ScriptText 'ignored' -Control $control -MaximumMilliseconds 25 -PowerShellFactory $factory); 'unexpected' } catch { $_.Exception.Message }",
      "[ordered]@{ failure = $failure; disposeCalls = [IntentArcEndStopThrowingPowerShell]::DisposeCalls } | ConvertTo-Json -Compress",
    ].join("\r\n"));

    expect(result).toEqual({ failure: "stop-finalization", disposeCalls: 1 });
  });

  const approvedReceiverSites = [
    {
      name: "release",
      receiver: "process",
      start: "if (-not $process.Start()) { throw 'release' }",
      continuationIndent: "        ",
    },
    {
      name: "verifier",
      receiver: "verifierProcess",
      start: "if (-not $verifierProcess.Start()) { throw 'artifact-verifier-start' }",
      continuationIndent: "            ",
    },
  ] as const;

  const receiverMutationCommands = [
    ["Set-Variable", (receiver: string) => `Set-Variable -Name ${receiver} -Value $null`],
    ["set", (receiver: string) => `set -Name ${receiver} -Value $null`],
    ["sv", (receiver: string) => `sv ${receiver} $null`],
    ["New-Variable", (receiver: string) => `New-Variable -Name ${receiver} -Value $null`],
    ["nv", (receiver: string) => `nv ${receiver} $null`],
    ["Clear-Variable", (receiver: string) => `Clear-Variable -Name ${receiver}`],
    ["clv", (receiver: string) => `clv ${receiver}`],
    ["Remove-Variable", (receiver: string) => `Remove-Variable -Name ${receiver}`],
    ["rv", (receiver: string) => `rv ${receiver}`],
    ["Copy-Item", (receiver: string) => `Copy-Item -LiteralPath variable:decoy -Destination variable:${receiver}`],
    ["copy", (receiver: string) => `copy variable:decoy variable:${receiver}`],
    ["cp", (receiver: string) => `cp variable:decoy variable:${receiver}`],
    ["cpi", (receiver: string) => `cpi variable:decoy variable:${receiver}`],
    ["Move-Item", (receiver: string) => `Move-Item -LiteralPath variable:decoy -Destination variable:${receiver}`],
    ["move", (receiver: string) => `move variable:decoy variable:${receiver}`],
    ["mv", (receiver: string) => `mv variable:decoy variable:${receiver}`],
    ["mi", (receiver: string) => `mi variable:decoy variable:${receiver}`],
    ["Rename-Item", (receiver: string) => `Rename-Item -LiteralPath variable:decoy -NewName ${receiver}`],
    ["ren", (receiver: string) => `ren variable:decoy ${receiver}`],
    ["rni", (receiver: string) => `rni variable:decoy ${receiver}`],
    ["Set-Item", (receiver: string) => `Set-Item -LiteralPath variable:${receiver} -Value $null`],
    ["si", (receiver: string) => `si variable:${receiver} $null`],
    ["New-Item", (receiver: string) => `New-Item -Path variable:${receiver} -Value $null`],
    ["ni", (receiver: string) => `ni variable:${receiver} -Value $null`],
    ["Clear-Item", (receiver: string) => `Clear-Item -LiteralPath variable:${receiver}`],
    ["cli", (receiver: string) => `cli variable:${receiver}`],
    ["Remove-Item", (receiver: string) => `Remove-Item -LiteralPath variable:${receiver}`],
    ["del", (receiver: string) => `del variable:${receiver}`],
    ["erase", (receiver: string) => `erase variable:${receiver}`],
    ["rd", (receiver: string) => `rd variable:${receiver}`],
    ["ri", (receiver: string) => `ri variable:${receiver}`],
    ["rm", (receiver: string) => `rm variable:${receiver}`],
    ["rmdir", (receiver: string) => `rmdir variable:${receiver}`],
  ] as const;

  it.each(receiverMutationCommands)(
    "source policy rejects %s receiver mutation against both approved roles",
    async (name, buildCommand) => {
      // Break caught: every Windows PowerShell built-in mutator spelling can
      // rebind a variable-provider receiver without adding a second assignment AST.
      const source = await readFile(controllerScriptPath, "utf8");
      const results = await Promise.all(approvedReceiverSites.map(async (site) => {
        const mutated = source.replace(
          site.start,
          `${buildCommand(site.receiver)}\r\n${site.continuationIndent}${site.start}`,
        );
        return { site: site.name, result: await evaluateControllerSourcePolicy(mutated) };
      }));
      for (const inspected of results) {
        expect(inspected.result.valid, `${name}:${inspected.site}`).toBe(false);
        expect(inspected.result.violations, `${name}:${inspected.site}`).toContain("process-start-count");
      }
    },
  );

  const qualifiedReceiverMutations = [
    ...["global", "local", "script", "private"].flatMap((scope) => [
      [`${scope}-qualified assignment`, (receiver: string) => `$${scope}:${receiver} = $null`],
      [`${scope}-qualified reference`, (receiver: string) => `$${scope}:${receiver}`],
    ] as const),
    ["variable-provider-qualified assignment", (receiver: string) => `$` + `{variable:${receiver}} = $null`],
    ["variable-provider-qualified reference", (receiver: string) => `$` + `{variable:${receiver}}`],
  ] as const;

  it.each(qualifiedReceiverMutations)(
    "source policy rejects %s for both approved receiver identities",
    async (name, buildMutation) => {
      // Break caught: a qualified path to an approved receiver is the same
      // PowerShell variable identity, not an independent raw UserPath key.
      const source = await readFile(controllerScriptPath, "utf8");
      const results = await Promise.all(approvedReceiverSites.map(async (site) => {
        const mutation = buildMutation(site.receiver);
        const mutated = name.endsWith("assignment")
          ? source.replace(site.start, `${mutation}\r\n${site.continuationIndent}${site.start}`)
          : source.replace(`$${site.receiver}.Start()`, `${mutation}.Start()`);
        return { site: site.name, result: await evaluateControllerSourcePolicy(mutated) };
      }));
      for (const inspected of results) {
        expect(inspected.result.valid, `${name}:${inspected.site}`).toBe(false);
        expect(inspected.result.violations, `${name}:${inspected.site}`).toContain("process-start-count");
      }
    },
  );

  const nestedReceiverAssignmentTargets = [
    ["parenthesized", (receiver: string) => `($${receiver}) = $null`],
    ["nested-parenthesized", (receiver: string) => `(($${receiver})) = $null`],
    ["tuple-first", (receiver: string) => `$${receiver}, $null = 1, $null`],
    ["tuple-middle", (receiver: string) => `$null, $${receiver} = 1, $null`],
    ["tuple-parenthesized", (receiver: string) => `$null, ($${receiver}) = 1, $null`],
    ["converted", (receiver: string) => `[object]$${receiver} = $null`],
    ["converted-parenthesized", (receiver: string) => `[object]($${receiver}) = $null`],
    ["attributed", (receiver: string) => `[ValidateNotNull()]$${receiver} = $null`],
    ["qualified-parenthesized", (receiver: string) => `($local:${receiver}) = $null`],
    ["qualified-tuple", (receiver: string) => `$null, $` + `{variable:${receiver}} = 1, $null`],
  ] as const;

  it.each(nestedReceiverAssignmentTargets)(
    "source policy rejects %s assignment targets for both approved receiver identities",
    async (name, buildAssignment) => {
      // Break caught: assignment targets can recursively wrap the receiver in
      // parentheses, tuple/list destructuring, conversion, or an attribute.
      const source = await readFile(controllerScriptPath, "utf8");
      const results = await Promise.all(approvedReceiverSites.map(async (site) => {
        const mutated = source.replace(
          site.start,
          `${buildAssignment(site.receiver)}\r\n${site.continuationIndent}${site.start}`,
        );
        return { site: site.name, result: await evaluateControllerSourcePolicy(mutated) };
      }));
      for (const inspected of results) {
        expect(inspected.result.valid, `${name}:${inspected.site}`).toBe(false);
        expect(inspected.result.violations, `${name}:${inspected.site}`).toContain("process-start-count");
      }
    },
  );

  it("source policy preserves parenthesized member assignment to approved process StartInfo", async () => {
    // Break caught: recursively scanning every descendant variable would
    // misclassify a property write as rebinding the receiver itself.
    const source = await readFile(controllerScriptPath, "utf8");
    const mutated = source
      .replace("$process.StartInfo = $startInfo", "($process).StartInfo = $startInfo")
      .replace("$verifierProcess.StartInfo = $verifierInfo", "($verifierProcess).StartInfo = $verifierInfo");
    const result = await evaluateControllerSourcePolicy(mutated);

    expect(result).toEqual({
      valid: true,
      violations: [],
      reviewedProcessStarts: { InvokeRelease: 1, PublishClosedArtifactBundle: 1, GetRuntimeClosure: 1, BoundGit: 1 },
    });
  });

  it.each([
    ["second release invocation", "release-call-count", (source: string) => source.replace(
      "$release = & $Operations['InvokeRelease'] $Manifest",
      "$release = & $Operations['InvokeRelease'] $Manifest\r\n        $release = & $Operations['InvokeRelease'] $Manifest",
    )],
    ["wildcard cleanup", "wildcard-prefix-removal", (source: string) =>
      `${source}\r\nfunction Invoke-ForbiddenCleanup { Remove-Item -Path 'Cert:\\CurrentUser\\My\\ABC*' -Recurse }`],
    ["LocalMachine certificate store", "local-machine-store", (source: string) =>
      `${source}\r\nfunction Invoke-ForbiddenStore { Get-ChildItem -LiteralPath 'Cert:\\LocalMachine\\My' }`],
    ["Setup lifecycle execution", "forbidden-lifecycle", (source: string) =>
      `${source}\r\nfunction Invoke-ForbiddenSetup { & 'C:\\release\\IntentArc Setup.exe' }`],
    ["application launch", "forbidden-lifecycle", (source: string) =>
      `${source}\r\nfunction Invoke-ForbiddenApplication { & 'C:\\release\\IntentArc.exe' }`],
    ["process-based lifecycle launch", "forbidden-lifecycle", (source: string) =>
      `${source}\r\nfunction Invoke-ForbiddenProcessLaunch { Start-Process -FilePath 'C:\\release\\Update.exe' }`],
    ["external publication", "external-publication", (source: string) =>
      `${source}\r\nfunction Invoke-ForbiddenUpload { Invoke-WebRequest -Uri 'https://invalid.example/upload' }`],
    ["direct make", "direct-make", (source: string) =>
      `${source}\r\nfunction Invoke-ForbiddenMake { & 'pnpm.exe' 'desktop:make' }`],
    ["execution policy bypass", "execution-policy-bypass", (source: string) =>
      `${source}\r\nfunction Invoke-ForbiddenPolicy { & 'powershell.exe' -ExecutionPolicy Bypass }`],
    ["ambient release discovery", "ambient-executable", (source: string) =>
      `${source}\r\nfunction Resolve-ForbiddenRelease { Get-Command -All -Name 'pnpm.exe' }`],
    ["additional direct Process.Start", "process-start-count", (source: string) =>
      `${source}\r\nfunction Invoke-ForbiddenProcessMember { [Diagnostics.Process]::Start('C:\\Windows\\System32\\cmd.exe') }`],
    ["call-operator Process construction", "process-start-count", (source: string) => source.replace(
      "$process = New-Object Diagnostics.Process",
      "$process = & New-Object Diagnostics.Process",
    )],
    ["release receiver direct reassignment", "process-start-count", (source: string) => source.replace(
      "$process.StartInfo = $startInfo",
      "$process.StartInfo = $startInfo\r\n        $process = $null",
    )],
    ["verifier receiver direct reassignment", "process-start-count", (source: string) => source.replace(
      "$verifierProcess.StartInfo = $verifierInfo",
      "$verifierProcess.StartInfo = $verifierInfo\r\n        $verifierProcess = $null",
    )],
    ["release receiver alias start", "process-start-count", (source: string) => source.replace(
      "if (-not $process.Start()) { throw 'release' }",
      "$releaseAlias = $process\r\n        if (-not $releaseAlias.Start()) { throw 'release' }",
    )],
    ["verifier receiver alias start", "process-start-count", (source: string) => source.replace(
      "if (-not $verifierProcess.Start()) { throw 'artifact-verifier-start' }",
      "$verifierAlias = $verifierProcess\r\n            if (-not $verifierAlias.Start()) { throw 'artifact-verifier-start' }",
    )],
    ["extra Stopwatch Start receiver", "process-start-count", (source: string) =>
      `${source}\r\nfunction Measure-ForbiddenWork { $watch = [Diagnostics.Stopwatch]::StartNew(); $watch.Start(); $watch.Stop() }`],
    ["extra unreviewed Start receiver", "process-start-count", (source: string) =>
      `${source}\r\nfunction Invoke-ForbiddenStart { param($Receiver); $Receiver.Start() }`],
    ["WebClient upload member", "external-publication", (source: string) =>
      `${source}\r\nfunction Invoke-ForbiddenWebClient { $client = New-Object Net.WebClient; $client.UploadFile('https://invalid.example', 'C:\\payload') }`],
    ["HttpClient PostAsync publication", "external-publication", (source: string) =>
      `${source}\r\nfunction Invoke-ForbiddenHttpClient { $client = [Net.Http.HttpClient]::new(); $client.PostAsync('https://invalid.example', $null) }`],
    ["source-time file write", "source-time-effect", (source: string) =>
      `${source}\r\n[IO.File]::WriteAllText('C:\\outside.txt', 'forbidden')`],
    ["reviewed import replaced by source-time write", "source-time-effect", (source: string) => source.replace(
      ". (Join-Path $PSScriptRoot 'signed-release-once-manifest.ps1')",
      "[IO.File]::WriteAllText('C:\\outside.txt', 'forbidden')",
    )],
    ["composed direct make", "direct-make", (source: string) =>
      `${source}\r\nfunction Invoke-ForbiddenComposedMake { $prefix = 'desktop:'; $verb = $prefix + 'make'; & 'pnpm.exe' $verb }`],
    ["four-fragment direct make", "direct-make", (source: string) =>
      `${source}\r\nfunction Invoke-ForbiddenFourFragmentMake { & 'pnpm.exe' ('desk' + 'top:' + 'ma' + 'ke') }`],
    ["variable-fragment direct make", "direct-make", (source: string) =>
      `${source}\r\nfunction Invoke-ForbiddenVariableMake { $a='desk'; $b='top:'; $c='ma'; $d='ke'; & 'pnpm.exe' ($a+$b+$c+$d) }`],
    ["aliased static Process.Start", "process-start-count", (source: string) =>
      `${source}\r\nfunction Invoke-ForbiddenAliasedProcess { $processType = [Diagnostics.Process]; $processType::Start('C:\\Windows\\System32\\cmd.exe') }`],
    ["unreviewed Process instance", "process-start-count", (source: string) =>
      `${source}\r\nfunction Invoke-ForbiddenOtherProcess { $other = New-Object Diagnostics.Process; [void]$other.Start() }`],
    ["unreviewed fully-qualified Process instance", "process-start-count", (source: string) =>
      `${source}\r\nfunction Invoke-ForbiddenOtherProcess { $other = New-Object System.Diagnostics.Process; [void]$other.Start() }`],
    ["unreviewed case-varied Process instance", "process-start-count", (source: string) =>
      `${source}\r\nfunction Invoke-ForbiddenOtherProcess { $other = New-Object dIaGnOsTiCs.pRoCeSs; [void]$OTHER.sTaRt() }`],
    ["unreviewed Process -TypeName instance", "process-start-count", (source: string) =>
      `${source}\r\nfunction Invoke-ForbiddenOtherProcess { $other = New-Object -TypeName System.Diagnostics.Process; [void]$other.Start() }`],
    ["unreviewed Process constructor instance", "process-start-count", (source: string) =>
      `${source}\r\nfunction Invoke-ForbiddenConstructorProcess { $other = [Diagnostics.Process]::new(); [void]$other.Start() }`],
    ["variable-typed New-Object Process instance", "process-start-count", (source: string) =>
      `${source}\r\nfunction Invoke-ForbiddenVariableTypeProcess { $type = 'Diagnostics.Process'; $other = New-Object $type; [void]$other.Start() }`],
    ["variable type static Process Start", "process-start-count", (source: string) =>
      `${source}\r\nfunction Invoke-ForbiddenVariableStaticProcess { $t = [Diagnostics.Process]; [void]$t::Start('C:\\Windows\\System32\\cmd.exe') }`],
    ["reassigned Stopwatch role", "process-start-count", (source: string) =>
      `${source}\r\nfunction Measure-BenignWork { $watch = [Diagnostics.Stopwatch]::StartNew(); $watch = [Diagnostics.Process]::new(); [void]$watch.Start() }`],
    ["New-Object HttpClient publication", "external-publication", (source: string) =>
      `${source}\r\nfunction Invoke-ForbiddenNewHttpClient { $client = New-Object Net.Http.HttpClient; $client.PostAsync('https://invalid.example', $null) }`],
    ["removed pre-marker repository config binding", "release-config-isolation", (source: string) => source.replace(
      "if (-not (Test-IntentArcRepositoryPackageManagerIsolation -RepositoryRoot $Manifest.repository.root)) { throw 'execution-input-binding' }",
      "if ($false) { throw 'execution-input-binding' }",
    )],
    ["splatted execution policy bypass", "execution-policy-bypass", (source: string) =>
      `${source}\r\nfunction Invoke-ForbiddenSplat { $parameters = @{ ExecutionPolicy = 'Bypass' }; & 'powershell.exe' @parameters }`],
    ["enum LocalMachine store", "local-machine-store", (source: string) =>
      `${source}\r\nfunction Invoke-ForbiddenEnumStore { [Security.Cryptography.X509Certificates.StoreLocation]::LocalMachine }`],
    ["console sensitive logging", "sensitive-logging", (source: string) =>
      `${source}\r\nfunction Invoke-ForbiddenConsoleLog { param($PrivateKey); [Console]::Error.WriteLine($PrivateKey) }`],
    ["web command alias", "external-publication", (source: string) =>
      `${source}\r\nfunction Invoke-ForbiddenAlias { iwr 'https://invalid.example' }`],
    ["policy-body external command", "external-publication", (source: string) => source.replace(
      /(\s+)return \[ordered\]@\{\s+valid = \(\$violations\.Count -eq 0\)/,
      "$1Invoke-WebRequest -Uri 'https://invalid.example'$1return [ordered]@{$1    valid = ($violations.Count -eq 0)",
    )],
    ["parameterless process wait", "unbounded-wait", (source: string) =>
      `${source}\r\nfunction Invoke-ForbiddenWait { param($Process); $Process.WaitForExit() }`],
    ["unbounded whole-stream read", "unbounded-output", (source: string) =>
      `${source}\r\nfunction Read-ForbiddenOutput { param($Reader); $Reader.ReadToEndAsync() }`],
    ["recursive copy cmdlet", "recursive-tree-effect", (source: string) =>
      `${source}\r\nfunction Invoke-ForbiddenTreeCopy { param($From,$To); Copy-Item -LiteralPath $From -Destination $To -Recurse }`],
    ["recursive directory delete", "recursive-tree-effect", (source: string) =>
      `${source}\r\nfunction Invoke-ForbiddenTreeDelete { param($Path); [IO.Directory]::Delete($Path, $true) }`],
    ["sensitive logging", "sensitive-logging", (source: string) =>
      `${source}\r\nfunction Invoke-ForbiddenLog { param($Password); Write-Host $Password }`],
  ] as const)("forbidden operation source policy rejects %s", async (_name, category, mutate) => {
    // Break caught: each semantic mutant represents a controller-owned action
    // that is outside the authorized one-shot release boundary.
    const source = await readFile(controllerScriptPath, "utf8");
    const result = await evaluateControllerSourcePolicy(mutate(source));

    expect(result.valid).toBe(false);
    expect(result.violations).toContain(category);
  });

  it("source policy permits a benign LiteralPath wildcard comparison with no removal effect", async () => {
    // Break caught: rejecting every -like comparison makes the guard noisy and
    // encourages unsafe exclusions that also hide real forbidden operations.
    const source = await readFile(controllerScriptPath, "utf8");
    const result = await evaluateControllerSourcePolicy(
      `${source}\r\nfunction Test-BenignLiteralPath { param($LiteralPath); return $LiteralPath -like 'C:\\safe\\*' }`,
    );

    expect(result).toEqual({
      valid: true,
      violations: [],
      reviewedProcessStarts: { InvokeRelease: 1, PublishClosedArtifactBundle: 1, GetRuntimeClosure: 1, BoundGit: 1 },
    });
  });

  it("source policy rejects non-process Start receivers", async () => {
    const source = await readFile(controllerScriptPath, "utf8");
    const result = await evaluateControllerSourcePolicy(
      `${source}\r\nfunction Measure-BenignWork { $watch = [Diagnostics.Stopwatch]::StartNew(); $watch.Start(); $watch.Stop() }`,
    );

    expect(result.valid).toBe(false);
    expect(result.violations).toContain("process-start-count");
  });

  it("source policy reports exactly the four reviewed process Start roles", async () => {
    const source = await readFile(controllerScriptPath, "utf8");
    const result = await evaluateControllerSourcePolicy(source);

    expect(result.valid).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.reviewedProcessStarts).toEqual({
      InvokeRelease: 1,
      PublishClosedArtifactBundle: 1,
      GetRuntimeClosure: 1,
      BoundGit: 1,
    });
  });

  it("static self-test constructs production defaults but invokes only its recording map", async () => {
    // Break caught: static validation that calls a default scriptblock would cross
    // a live boundary even when every operation body is otherwise dormant.
    const guardedStaticCommand = [
      "$ErrorActionPreference = 'Stop'",
      "$ProgressPreference = 'SilentlyContinue'",
      "$script:mutations = 0",
      "function global:Start-Process { $script:mutations++; throw 'unexpected live mutation' }",
      "function global:New-SelfSignedCertificate { $script:mutations++; throw 'unexpected live mutation' }",
      "function global:Export-PfxCertificate { $script:mutations++; throw 'unexpected live mutation' }",
      "function global:Export-Certificate { $script:mutations++; throw 'unexpected live mutation' }",
      `& '${escapePowerShell(controllerScriptPath)}' -StaticSelfTest`,
    ].join("\r\n");
    const result = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(guardedStaticCommand)],
      {
        encoding: "utf8",
        env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR },
        maxBuffer: 32 * 1024,
        timeout: 30_000,
        windowsHide: true,
      },
    );

    expect(result.stderr).toBe("");
    expect(result.stdout).toBe('{"status":"STATIC_PASS","mutations":0}\r\n');

    const observed = await runControllerPowerShell([
      "$script:constructorCalls = 0",
      "$originalConstructor = ${function:New-IntentArcSignedReleaseOperations}",
      "function New-IntentArcSignedReleaseOperations { $script:constructorCalls++; & $originalConstructor }",
      "$writer = New-Object IO.StringWriter",
      "$priorWriter = [Console]::Out",
      "[Console]::SetOut($writer)",
      "try { Invoke-IntentArcSignedReleaseStaticSelfTest } finally { [Console]::SetOut($priorWriter) }",
      "[ordered]@{ constructorCalls = $script:constructorCalls; output = $writer.ToString() } | ConvertTo-Json -Compress",
    ].join("\r\n"));
    expect(observed).toEqual({
      constructorCalls: 1,
      output: '{"status":"STATIC_PASS","mutations":0}\r\n',
    });
  });

  it("inert direct execution refuses without constructing production defaults", async () => {
    // Break caught: moving construction ahead of the Execute gate would make an
    // ordinary direct invocation perform discovery or prepare live operations.
    let failure: unknown;
    try {
      const guardedDirectCommand = [
        "$ErrorActionPreference = 'Stop'",
        "$ProgressPreference = 'SilentlyContinue'",
        "$script:constructorEffects = 0",
        "function global:Add-Member { $script:constructorEffects++; throw 'constructor crossed execute gate' }",
        `& '${escapePowerShell(controllerScriptPath)}'`,
      ].join("\r\n");
      await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(guardedDirectCommand)],
        {
          encoding: "utf8",
          env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR },
          maxBuffer: 32 * 1024,
          timeout: 30_000,
          windowsHide: true,
        },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      code: 1,
      stdout: '{"status":"REFUSED","category":"execute-required","mutations":0}\r\n',
      stderr: "",
    });
  });

  it("pre-load traps catch source-time and constructor-time effect mutants", async () => {
    // Break caught: installing traps after dot-source makes dormant tests vacuous.
    const source = await readFile(controllerScriptPath, "utf8");
    const root = await mkdtemp(join(tmpdir(), "intentarc-controller-dormancy-"));
    temporaryRoots.push(root);
    const sourceEffectPath = join(root, "source-effect.ps1");
    const constructorEffectPath = join(root, "constructor-effect.ps1");
    await Promise.all([
      writeFile(join(root, "signed-release-once-manifest.ps1"), await readFile(scriptPath)),
      writeFile(join(root, "signed-release-once-residue.ps1"), await readFile(residueScriptPath)),
    ]);
    await writeFile(sourceEffectPath, `${source}\r\nStart-Process 'forbidden-source-effect'`, "utf8");
    await writeFile(constructorEffectPath, source.replace(
      "function New-IntentArcSignedReleaseOperations {",
      "function New-IntentArcSignedReleaseOperations {\r\n    Start-Process 'forbidden-constructor-effect'",
    ), "utf8");
    const inspect = async (candidatePath: string, invokeConstructor: boolean) => {
      const command = [
        "$ErrorActionPreference = 'Stop'",
        "$ProgressPreference = 'SilentlyContinue'",
        "$script:mutations = 0",
        "function global:Start-Process { $script:mutations++; throw 'dormancy-trap' }",
        `$outcome = try { . '${escapePowerShell(candidatePath)}'; ${invokeConstructor ? "[void](New-IntentArcSignedReleaseOperations)" : ""}; 'accepted' } catch { $_.Exception.Message }`,
        "[ordered]@{ mutations = $script:mutations; outcome = $outcome } | ConvertTo-Json -Compress",
      ].join("\r\n");
      const result = await execFileAsync("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(command),
      ], { encoding: "utf8", env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } });
      return JSON.parse(result.stdout) as { mutations: number; outcome: string };
    };

    expect(await inspect(sourceEffectPath, false)).toEqual({ mutations: 1, outcome: "dormancy-trap" });
    expect(await inspect(constructorEffectPath, true)).toEqual({ mutations: 1, outcome: "dormancy-trap" });
  }, 15_000);
});

windowsOnly("signed release residue projection", () => {
  it("projects a real dist tree with ordinal relative entries and stable file evidence", async () => {
    const { dist } = await createResidueFixture();

    const projection = await runResidue(
      `Get-IntentArcResidueProjection -LiteralRoot '${escapePowerShell(dist)}' | ConvertTo-Json -Depth 8 -Compress`,
    );

    expect(projection).toEqual({
      root: { presence: "present", type: "directory" },
      entries: [
        {
          path: "Alpha.TXT",
          type: "file",
          byteSize: 2,
          sha256: "38164fbd17603d73f696b8b4d72664d735bb6a7c88577687fd2ae33fd6964153",
        },
        { path: "empty", type: "directory", byteSize: 0, sha256: null },
        { path: "squirrel-vendor", type: "directory", byteSize: 0, sha256: null },
        { path: "squirrel-vendor\\nested", type: "directory", byteSize: 0, sha256: null },
        {
          path: "squirrel-vendor\\nested\\payload.bin",
          type: "file",
          byteSize: 3,
          sha256: "2da45f2cd1f9c8e69a67abf7a6b26c282533d0a7686787a9533265418680d4d2",
        },
      ],
    });
    expect(JSON.stringify(projection)).not.toContain(dist);
  });

  it("projects a real out tree without leaking unrelated injected identities", async () => {
    const { out } = await createResidueFixture();

    const projection = await runResidue([
      "$env:INTENTARC_TEST_SENTINEL = 'unit-test-environment-value'",
      "$global:IntentArcTestSentinel = 'unit-test-secret-key-name'",
      "try {",
      `  $serialized = Get-IntentArcResidueProjection -LiteralRoot '${escapePowerShell(out)}' | ConvertTo-Json -Depth 8 -Compress`,
      "} finally {",
      "  Remove-Item Env:INTENTARC_TEST_SENTINEL -ErrorAction SilentlyContinue",
      "  Remove-Variable -Name IntentArcTestSentinel -Scope Global -ErrorAction SilentlyContinue",
      "}",
      "$serialized",
    ].join("\r\n"));

    expect(projection).toEqual({
      root: { presence: "present", type: "directory" },
      entries: [
        {
          path: "read-only.txt",
          type: "file",
          byteSize: 9,
          sha256: "4fed3970dcc0d31dccddbf69ef55b00f32d2ca787f1757894914bc0365ea7aa5",
        },
        {
          path: "zeta.txt",
          type: "file",
          byteSize: 1,
          sha256: "594e519ae499312b29433b7dd8a97ff068defcba9755b6d5d00e84c524d67b06",
        },
      ],
    });
    expect(JSON.stringify(projection)).not.toContain("unit-test-secret-key-name");
    expect(JSON.stringify(projection)).not.toContain("unit-test-environment-value");
  });

  it("reports hand-built missing, extra, size, byte, and type projection differences", async () => {
    const { dist } = await createResidueFixture();
    const expected = await runResidue(
      `Get-IntentArcResidueProjection -LiteralRoot '${escapePowerShell(dist)}' | ConvertTo-Json -Depth 8 -Compress`,
    );
    await writeFile(join(dist, "Alpha.TXT"), Buffer.from([0x41]));
    await rm(join(dist, "empty"), { recursive: true });
    await writeFile(join(dist, "extra.txt"), "extra", "utf8");
    await rm(join(dist, "squirrel-vendor", "nested", "payload.bin"));
    await mkdir(join(dist, "squirrel-vendor", "nested", "payload.bin"));

    const comparison = await runResidue([
      `$expected = '${escapePowerShell(JSON.stringify(expected))}' | ConvertFrom-Json`,
      `$actual = Get-IntentArcResidueProjection -LiteralRoot '${escapePowerShell(dist)}'`,
      "Compare-IntentArcResidueProjection -Expected $expected -Actual $actual | ConvertTo-Json -Depth 8 -Compress",
    ].join("\r\n"));

    expect(comparison).toEqual({
      equal: false,
      differences: [
        { category: "entry-byte-size-mismatch", path: "Alpha.TXT" },
        { category: "entry-sha256-mismatch", path: "Alpha.TXT" },
        { category: "missing-entry", path: "empty" },
        { category: "extra-entry", path: "extra.txt" },
        { category: "entry-type-mismatch", path: "squirrel-vendor\\nested\\payload.bin" },
      ],
    });
    expect(JSON.stringify(comparison)).not.toContain(dist);
  });

  it("refuses a contained reparse point instead of following it", async () => {
    const { root } = await createResidueFixture();
    const target = join(root, "reparse-target");
    const link = join(root, "reparse-link");
    await mkdir(target);
    await writeFile(join(target, "outside.txt"), "outside", "utf8");
    await symlink(target, link, "junction");

    const result = await runResidue([
      "try {",
      `  Get-IntentArcResidueProjection -LiteralRoot '${escapePowerShell(root)}' | Out-Null`,
      "  [ordered]@{ category = 'accepted' } | ConvertTo-Json -Compress",
      "} catch {",
      "  [ordered]@{ category = $_.Exception.Message } | ConvertTo-Json -Compress",
      "}",
    ].join("\r\n"));

    expect(result).toEqual({ category: "residue-projection-reparse-point" });
  });

  it("rejects an absolute comparison entry before it can leak a path", async () => {
    const result = await runResidue([
      "$expected = [ordered]@{ root = [ordered]@{ presence = 'present'; type = 'directory' }; entries = @([ordered]@{ path = 'C:\\unrelated\\identity.txt'; type = 'file'; byteSize = 1; sha256 = 'a' }) }",
      "$actual = [ordered]@{ root = [ordered]@{ presence = 'present'; type = 'directory' }; entries = @() }",
      "$(try { Compare-IntentArcResidueProjection -Expected $expected -Actual $actual | Out-Null; 'accepted' } catch { $_.Exception.Message }) | ConvertTo-Json -Compress",
    ].join("\r\n"));

    expect(result).toBe("residue-projection-invalid");
  });

  it("sorts all normalized relative entries ordinally rather than depth-first", async () => {
    const { root } = await createResidueFixture();
    const projectionRoot = join(root, "ordering");
    await mkdir(join(projectionRoot, "a"), { recursive: true });
    await writeFile(join(projectionRoot, "a", "z"), "z", "utf8");
    await writeFile(join(projectionRoot, "a.txt"), "dot", "utf8");

    const projection = await runResidue(
      `Get-IntentArcResidueProjection -LiteralRoot '${escapePowerShell(projectionRoot)}' | ConvertTo-Json -Depth 8 -Compress`,
    );

    expect(projection.entries.map((entry: { path: string }) => entry.path)).toEqual([
      "a",
      "a.txt",
      "a\\z",
    ]);
  });

  it("compares real missing, file, and directory root state before entries", async () => {
    const { root, out } = await createResidueFixture();
    const missing = join(root, "missing-root");
    const file = join(root, "root-file.bin");
    await writeFile(file, "root", "utf8");

    const result = await runResidue([
      `  $missing = Get-IntentArcResidueProjection -LiteralRoot '${escapePowerShell(missing)}'`,
      `  $directory = Get-IntentArcResidueProjection -LiteralRoot '${escapePowerShell(out)}'`,
      `  $file = Get-IntentArcResidueProjection -LiteralRoot '${escapePowerShell(file)}'`,
      "  [ordered]@{ missing = Compare-IntentArcResidueProjection -Expected $directory -Actual $missing; file = Compare-IntentArcResidueProjection -Expected $directory -Actual $file } | ConvertTo-Json -Depth 8 -Compress",
    ].join("\r\n"));

    expect(result).toEqual({
      missing: { equal: false, differences: [{ category: "root-presence-mismatch" }] },
      file: { equal: false, differences: [{ category: "root-type-mismatch" }] },
    });
  });
});

windowsOnly("signed release cleanup containment", () => {
  it("allows only the exact cleanup root or its resolved descendants", async () => {
    const { root, dist } = await createResidueFixture();
    await mkdir(join(root, "dist-other"));
    const result = await runResidue([
      "[ordered]@{",
      `  exact = Test-IntentArcCleanupContainment -LiteralRoot '${escapePowerShell(dist)}' -LiteralCandidate '${escapePowerShell(dist)}'`,
      `  child = Test-IntentArcCleanupContainment -LiteralRoot '${escapePowerShell(dist)}' -LiteralCandidate '${escapePowerShell(join(dist, "squirrel-vendor"))}'`,
      `  sibling = Test-IntentArcCleanupContainment -LiteralRoot '${escapePowerShell(dist)}' -LiteralCandidate '${escapePowerShell(join(root, "dist-other"))}'`,
      "} | ConvertTo-Json -Compress",
    ].join("\r\n"));

    expect(result).toEqual({
      exact: "cleanup-target-contained",
      child: "cleanup-target-contained",
      sibling: "cleanup-target-outside-root",
    });
  });

  it("rejects a normal child beneath a real contained junction", async () => {
    const { root } = await createResidueFixture();
    const outside = join(root, "outside");
    const junction = join(root, "junction");
    await mkdir(outside);
    await writeFile(join(outside, "normal-child.txt"), "outside", "utf8");
    await symlink(outside, junction, "junction");

    const result = await runResidue(
      `Test-IntentArcCleanupContainment -LiteralRoot '${escapePowerShell(root)}' -LiteralCandidate '${escapePowerShell(join(junction, "normal-child.txt"))}' | ConvertTo-Json -Compress`,
    );

    expect(result).toBe("cleanup-target-reparse-point");
  });

  it("revalidates the canonical cleanup target after a real parent swap", async () => {
    const { root } = await createResidueFixture();
    const safe = join(root, "safe");
    const outside = join(root, "outside");
    const candidate = join(safe, "child.txt");
    await mkdir(safe);
    await mkdir(outside);
    await writeFile(candidate, "inside", "utf8");
    await writeFile(join(outside, "child.txt"), "outside", "utf8");

    const canonicalTarget = await runResidue(
      `Get-IntentArcValidatedCleanupTarget -LiteralRoot '${escapePowerShell(root)}' -LiteralCandidate '${escapePowerShell(candidate)}' | ConvertTo-Json -Compress`,
    );
    await rename(safe, join(root, "safe-before-swap"));
    await symlink(outside, safe, "junction");
    const result = await runResidue(
      `Confirm-IntentArcValidatedCleanupTarget -LiteralRoot '${escapePowerShell(root)}' -CanonicalTarget '${escapePowerShell(canonicalTarget)}' | ConvertTo-Json -Compress`,
    );

    expect(result).toBe("cleanup-target-reparse-point");
  });

  it("maps an injected confirmation exception to a closed cleanup category", async () => {
    const { root } = await createResidueFixture();
    const result = await runResidue([
      "function global:Get-IntentArcValidatedCleanupTarget { throw 'C:\\unit-test-raw-path\\injected-message' }",
      `Confirm-IntentArcValidatedCleanupTarget -LiteralRoot '${escapePowerShell(root)}' -CanonicalTarget '${escapePowerShell(root)}' | ConvertTo-Json -Compress`,
    ].join("\r\n"));

    expect(result).toBe("cleanup-target-invalid");
  });

  it.each([
    ["a parent traversal", "..\\candidate", "cleanup-target-invalid"],
    ["a wildcard", "*.tmp", "cleanup-target-invalid"],
    ["an alternate data stream", "file.txt:stream", "cleanup-target-invalid"],
    ["a drive-qualified alternate data stream", "C:\\safe\\file.txt:stream", "cleanup-target-invalid"],
    ["a reserved DOS device", "C:\\safe\\NUL", "cleanup-target-invalid"],
    ["a UNC path", "\\\\server\\share", "cleanup-target-invalid"],
    ["a drive root", "C:\\", "cleanup-target-invalid"],
    ["a drive-relative child", "C:child", "cleanup-target-invalid"],
    ["a drive-relative dot", "C:.", "cleanup-target-invalid"],
    ["an empty candidate", "", "cleanup-target-invalid"],
    ["a relative unresolved candidate", "missing", "cleanup-target-invalid"],
  ])("rejects %s before any cleanup effect", async (_name, candidate, expected) => {
    const { dist } = await createResidueFixture();
    const result = await runResidue(
      `Test-IntentArcCleanupContainment -LiteralRoot '${escapePowerShell(dist)}' -LiteralCandidate '${escapePowerShell(candidate)}' | ConvertTo-Json -Compress`,
    );

    expect(result).toBe(expected);
  });

  it("accepts only the fixed nonnegative injected residue count keys", async () => {
    const result = await runResidue([
      "$env:INTENTARC_TEST_SENTINEL = 'unit-test-environment-value'",
      "$global:IntentArcTestSentinel = 'unit-test-secret-key-name'",
      "$counts = [ordered]@{ myCertificate = 0; rootTrust = 0; trustedPublisherTrust = 0; cngKey = 0; pfx = 0; cer = 0; runtime = 0; process = 0; signingEnvironment = 0; generatedDist = 0; generatedOut = 0; recoveryDirectory = 0 }",
      "try { $serialized = New-IntentArcBoundedResidueSummary -Counts $counts | ConvertTo-Json -Compress } finally { Remove-Item Env:INTENTARC_TEST_SENTINEL -ErrorAction SilentlyContinue; Remove-Variable -Name IntentArcTestSentinel -Scope Global -ErrorAction SilentlyContinue }",
      "$serialized",
    ].join("\r\n"));

    expect(result).toEqual({
      myCertificate: 0,
      rootTrust: 0,
      trustedPublisherTrust: 0,
      cngKey: 0,
      pfx: 0,
      cer: 0,
      runtime: 0,
      process: 0,
      signingEnvironment: 0,
      generatedDist: 0,
      generatedOut: 0,
      recoveryDirectory: 0,
    });
    expect(JSON.stringify(result)).not.toContain("unit-test-secret-key-name");
    expect(JSON.stringify(result)).not.toContain("unit-test-environment-value");
  });

  it.each([
    ["an unknown count key", "$counts = [ordered]@{ unexpected = 0 }"],
    ["a negative count", "$counts = [ordered]@{ myCertificate = -1; rootTrust = 0; trustedPublisherTrust = 0; cngKey = 0; pfx = 0; cer = 0; runtime = 0; process = 0; signingEnvironment = 0; generatedDist = 0; generatedOut = 0; recoveryDirectory = 0 }"],
  ])("rejects %s", async (_name, setup) => {
    const result = await runResidue([
      setup,
      "$(try { New-IntentArcBoundedResidueSummary -Counts $counts | Out-Null; 'accepted' } catch { $_.Exception.Message }) | ConvertTo-Json -Compress",
    ].join("\r\n"));

    expect(result).toBe("bounded-residue-invalid");
  });
});

windowsOnly("signed release one-shot controller", () => {
  it("one-shot success consumes before the exact single release transaction", async () => {
    // Break caught: moving the marker, duplicating release, or skipping a stage changes
    // the externally recorded transaction and its bounded receipt.
    const result = await runController(await createFixture());

    expect(result.ok).toBe(true);
    expect(result.result).toMatchObject({
      schema: "intentarc.signed-release-receipt/v3",
      status: "PASS",
      primaryCategory: "none",
      cleanupCategories: [],
      highestCompletedState: "cleaned",
      releaseInvocationCount: 1,
      nestedMakeInvocationCount: 1,
      forbiddenLifecycleInvocationCount: 0,
      bridgeDiagnosticInvocationCount: 5,
      residue: emptyResidue,
    });
    expect(result.receipt).toEqual(result.result);
    expect(result.operations).toEqual([
        "BindExecutionInputs",
        "GetRepositoryState",
        "GetTrackedFileInventory",
        "GetFileHash",
        "GetRuntimeClosure",
        "GetBeforeProjection",
        "CreateConsumedMarkerAtomic",
        "PreserveOutputRoot",
        "PrepareCertificate",
        "AddTrust",
        "AddTrust",
        "VerifyTrust",
        "SetSigningEnvironment",
        "InvokeRelease",
        "SettleDescendants",
        "VerifyRelease",
        "PublishClosedArtifactBundle",
        "SettleDescendants",
        "ClearSigningEnvironment",
        "RemoveTrust",
        "RemoveTrust",
        "RemoveCertificate",
        "RemoveCngKey",
        "RemoveExactFile",
        "RemoveExactFile",
        "RemoveRuntime",
        "RemoveGeneratedOutput",
        "RemoveGeneratedOutput",
        "RestoreOutputRoot",
        "GetAfterProjection",
        "WriteReceiptAtomic",
      ]);
    expect(result.operations.indexOf("CreateConsumedMarkerAtomic"))
      .toBeLessThan(result.operations.indexOf("PreserveOutputRoot"));
    expect(result.operations.filter((name) => name === "InvokeRelease")).toHaveLength(1);
    expect(JSON.stringify(result.receipt)).not.toMatch(
      /unit-test-private-key|intentarc-signed-once-|SecureString|stdout|stderr|certificateBody/i,
    );
  });

  it("fails the controlled transaction when terminal verifier evidence reports zero diagnostics", async () => {
    // Break caught: standalone verifier count zero must never be promoted to
    // controlled PASS merely because signatures and bundle booleans are true.
    const result = await runController(await createFixture(), {
      bundleResultSource:
        "[ordered]@{ published = $true; artifactManifestSha256 = ('d' * 64); signatureVerified = $true; bridgePredecessorVerified = $true; artifactVerified = $true; bridgeDiagnosticInvocationCount = 0 }",
    });

    expect(result.result).toMatchObject({
      status: "FAIL",
      primaryCategory: "bridge-diagnostic-audit",
      bridgeDiagnosticInvocationCount: 0,
      releaseInvocationCount: 1,
      nestedMakeInvocationCount: 1,
      forbiddenLifecycleInvocationCount: 0,
      residue: emptyResidue,
    });
    expect(result.operations.filter((name) => name === "InvokeRelease")).toHaveLength(1);
    expect(result.operations.filter((name) => name === "PublishClosedArtifactBundle"))
      .toHaveLength(1);
    expect(result.receipt).toEqual(result.result);
  });

  it("rejects verifier count zero before final promotion and rolls back real staging output", async () => {
    // Break caught: promoting before checking the terminal audit count marks the
    // final tree published and makes the exact rollback operation refuse it.
    const result = await runProductionBundleComposition({
      auditText: "identity\npredecessor\nidentity\npredecessor\nidentity\n",
      verifierMode: "count-zero",
    });

    expect(result).toEqual({
      failure: "bridge-diagnostic-audit",
      rollback: "none",
      stagingExists: false,
      finalExists: false,
      publicationMarked: false,
      stateMarked: false,
    });
  });

  it("records a nonzero external-publication count in the failing receipt", async () => {
    // Break caught: a hard-coded receipt zero could hide an operation's
    // reported external publication attempt after the marker is consumed.
    const result = await runController(await createFixture(), {
      releaseResultSource: "[ordered]@{ releaseInvocations = 1; nestedMakeInvocations = 1; forbiddenLifecycleCount = 0; externalPublicationCount = 1 }",
    });

    expect(result.result).toMatchObject({
      status: "FAIL",
      primaryCategory: "release-result-invalid",
      externalPublicationInvocationCount: 1,
    });
    expect(result.receipt).toEqual(result.result);
  });

  it("refuses a changed runtime closure before consuming the marker", async () => {
    // Break caught: replacing the observed runtime digest with a constant can
    // authorize a dependency tree different from the manifest-bound closure.
    const result = await runController(await createFixture(), {
      runtimeClosureOverrides: { sha256: "f".repeat(64) },
    });

    expect(result.result).toEqual({
      status: "REFUSED",
      primaryCategory: "runtime-closure-invalid",
      highestCompletedState: "validated",
      releaseInvocations: 0,
      nestedMakeInvocations: 0,
      forbiddenLifecycleCount: 0,
      externalPublicationCount: 0,
      markerConsumed: false,
    });
    expect(result.operations).not.toContain("CreateConsumedMarkerAtomic");
  });

  it.each([
    ["partial audit", "identity\npredecessor\nidentity\n", "audit-signal", "bridge-diagnostic-audit"],
    ["reordered audit", "identity\nidentity\n", "audit-signal", "bridge-diagnostic-audit"],
    ["sixth audit token", "identity\npredecessor\nidentity\npredecessor\nidentity\npredecessor\n", "audit-signal", "bridge-diagnostic-audit"],
    ["exit two with nonempty stdout", "identity\npredecessor\nidentity\npredecessor\nidentity\n", "audit-signal-with-stdout", "artifact-verification"],
    ["exit two with the wrong stderr byte length", "identity\npredecessor\nidentity\npredecessor\nidentity\n", "audit-signal-wrong-stderr-length", "artifact-verification"],
    ["exit two with wrong same-length stderr", "identity\npredecessor\nidentity\npredecessor\nidentity\n", "audit-signal-wrong-same-length-stderr", "artifact-verification"],
    ["exit one with audit-shaped stderr", "identity\npredecessor\nidentity\npredecessor\nidentity\n", "audit-shaped-exit-one", "artifact-verification"],
    ["unrelated bridge-native verifier failure", "identity\npredecessor\nidentity\npredecessor\nidentity\n", "generic-signal", "artifact-verification"],
  ] as const)("classifies only the verifier's closed audit signal for %s", async (_name, auditText, verifierMode, expected) => {
    // Break caught: flattening the fixed audit signal hides malformed sequence
    // failures, while inferring from generic bridge-native text misclassifies
    // signature/native failures and risks surfacing untrusted details.
    const result = await runProductionBundleComposition({ auditText, verifierMode });

    expect(result).toEqual({
      failure: expected,
      rollback: "none",
      stagingExists: false,
      finalExists: false,
      publicationMarked: false,
      stateMarked: false,
    });
    expect(JSON.stringify(result)).not.toMatch(/controlled-run|bridge\.bin|publisher|secret/i);
  });

  it.each([
    ["directory", async (path: string) => mkdir(path)],
    ["nonempty ordinary file", async (path: string) => writeFile(path, "identity\n", "utf8")],
    ["oversized ordinary file", async (path: string) => writeFile(path, "x".repeat(129), "utf8")],
  ] as const)("rejects a preexisting audit %s before release without exposing its path", async (_kind, createLeaf) => {
    // Break caught: allowing any preexisting leaf at the controller-owned audit
    // path lets stale or attacker-selected evidence cross into the release.
    const fixture = await createFixture();
    const auditPath = join(
      fixture.manifest.repository.root,
      runDirectory,
      "bridge-diagnostics.tokens",
    );
    await createLeaf(auditPath);

    const result = await runController(fixture);

    expect(result.result).toMatchObject({
      status: "FAIL",
      primaryCategory: "bridge-diagnostic-audit",
      bridgeDiagnosticInvocationCount: 0,
      releaseInvocationCount: 0,
      residue: emptyResidue,
    });
    expect(result.operations).not.toContain("InvokeRelease");
    expect(result.receipt).toEqual(result.result);
    expect(JSON.stringify(result)).not.toContain(auditPath);
  });

  it("rejects a dangling audit reparse entry before starting the release child", async () => {
    // Break caught: File.Exists and Directory.Exists follow the target and both
    // report false for a dangling reparse entry even though the owned leaf name
    // is already occupied.
    const fixture = await createFixture();
    const runRoot = join(fixture.manifest.repository.root, runDirectory);
    const auditPath = join(runRoot, "bridge-diagnostics.tokens");
    const discardedTarget = join(runRoot, "discarded-audit-target");
    await mkdir(discardedTarget);
    await symlink(discardedTarget, auditPath, "junction");
    await rm(discardedTarget, { recursive: true, force: false });
    expect((await lstat(auditPath)).isSymbolicLink()).toBe(true);

    const result = await runController(fixture);

    expect(result.result).toMatchObject({
      status: "FAIL",
      primaryCategory: "bridge-diagnostic-audit",
      releaseInvocationCount: 0,
      bridgeDiagnosticInvocationCount: 0,
    });
    expect(result.operations).not.toContain("InvokeRelease");
    expect(JSON.stringify(result)).not.toContain(auditPath);
  });

  it("retains an ordinary partial audit leaf as evidence outside residue cleanup", async () => {
    // Break caught: classifying bounded audit evidence as runtime residue would
    // erase the only ordered forensic record after a consumed failed attempt.
    const fixture = await createFixture();
    const auditPath = join(
      fixture.manifest.repository.root,
      runDirectory,
      "bridge-diagnostics.tokens",
    );
    const result = await runController(fixture, {
      failedStages: ["release-after-audit"],
      releaseCreatesPartialAudit: true,
    });

    expect(result.result).toMatchObject({
      status: "FAIL",
      primaryCategory: "release",
      bridgeDiagnosticInvocationCount: 0,
      residue: emptyResidue,
    });
    expect(await readFile(auditPath, "utf8")).toBe("identity\n");
  });

  it("preserves the audit category for a leaf race caught by the release start builder", async () => {
    // Break caught: translating the builder's fixed audit failure to generic
    // release would conceal which closed boundary stopped product dispatch.
    const result = await runController(await createFixture(), {
      failedStages: ["bridge-diagnostic-audit"],
    });

    expect(result.result).toMatchObject({
      status: "FAIL",
      primaryCategory: "bridge-diagnostic-audit",
      bridgeDiagnosticInvocationCount: 0,
      releaseInvocationCount: 1,
      nestedMakeInvocationCount: 0,
      forbiddenLifecycleInvocationCount: 0,
      residue: emptyResidue,
    });
    expect(result.operations.filter((name) => name === "InvokeRelease")).toHaveLength(1);
    expect(result.operations).not.toContain("VerifyRelease");
    expect(result.operations).not.toContain("PublishClosedArtifactBundle");
  });

  it.each([
    ["interruption", 0, false],
    ["timeout", 1, true],
  ] as const)(
    "%s detection consumes the attempt, enters the full cleanup tail, and never starts a second release",
    async (stopMode, expectedReleaseCount, releaseStarted) => {
      // Break caught: cancellation/deadline detection that bypasses finally,
      // retries release, or leaves the marker reusable violates one-shot safety.
      const fixture = await createFixture();
      const result = await runController(fixture, {
        realOutputEffects: true,
        stopMode,
      });

      expect(result.ok).toBe(true);
      expect(result.result).toMatchObject({
        status: "FAIL",
        primaryCategory: stopMode,
        highestCompletedState: "cleaned",
        releaseInvocationCount: expectedReleaseCount,
        nestedMakeInvocationCount: 0,
        forbiddenLifecycleInvocationCount: 0,
        bridgeDiagnosticInvocationCount: 0,
        residue: emptyResidue,
      });
      expect(await pathExists(fixture.manifest.paths.consumedMarker)).toBe(true);
      expect(result.operations.filter((name) => name === "CreateConsumedMarkerAtomic"))
        .toHaveLength(1);
      expect(result.operations.filter((name) => name === "InvokeRelease"))
        .toHaveLength(expectedReleaseCount);
      expect(result.operations.includes("InvokeRelease")).toBe(releaseStarted);
      expect(result.operations).not.toContain("VerifyRelease");
      expect(result.operations).not.toContain("PublishClosedArtifactBundle");
      expect(result.operations.slice(result.operations.lastIndexOf("SettleDescendants")))
        .toEqual([
          "SettleDescendants",
          "ClearSigningEnvironment",
          "RemoveTrust",
          "RemoveTrust",
          "RemoveCertificate",
          "RemoveCngKey",
          "RemoveExactFile",
          "RemoveExactFile",
          "RemoveRuntime",
          "RemoveGeneratedOutput",
          "RemoveGeneratedOutput",
          "RestoreOutputRoot",
          "GetAfterProjection",
          "WriteReceiptAtomic",
        ]);
      expect(result.receipt).toEqual(result.result);
    },
  );

  it("an expired bounded deadline is detected immediately after consumption and before preservation", async () => {
    // Break caught: checking a deadline before marker creation would leave the
    // authorization reusable; checking it after preservation mutates too much.
    const fixture = await createFixture();
    const result = await runController(fixture, {
      realOutputEffects: true,
      stopMode: "deadline",
    });

    expect(result.ok).toBe(true);
    expect(result.result).toMatchObject({
      status: "FAIL",
      primaryCategory: "timeout",
      highestCompletedState: "cleaned",
      releaseInvocationCount: 0,
      nestedMakeInvocationCount: 0,
      bridgeDiagnosticInvocationCount: 0,
      residue: emptyResidue,
    });
    expect(await pathExists(fixture.manifest.paths.consumedMarker)).toBe(true);
    expect(result.operations.slice(0, 6)).toEqual([
      "BindExecutionInputs",
      "GetRepositoryState",
      "GetTrackedFileInventory",
      "GetFileHash",
      "GetRuntimeClosure",
      "GetBeforeProjection",
    ]);
    expect(result.operations).not.toContain("PreserveOutputRoot");
    expect(result.operations).not.toContain("InvokeRelease");
    expect(result.operations.at(-1)).toBe("WriteReceiptAtomic");
  });

  const cleanupTail = [
    "SettleDescendants",
    "ClearSigningEnvironment",
    "RemoveTrust",
    "RemoveTrust",
    "RemoveCertificate",
    "RemoveCngKey",
    "RemoveExactFile",
    "RemoveExactFile",
    "RemoveRuntime",
    "RemoveGeneratedOutput",
    "RemoveGeneratedOutput",
    "RestoreOutputRoot",
    "GetAfterProjection",
    "WriteReceiptAtomic",
  ];

  it.each([
    ["output preservation", "output-preservation", "output-preservation", 0],
    ["certificate create", "certificate-create", "certificate-create", 0],
    ["private-key open", "private-key-open", "private-key-open", 0],
    ["PFX export", "certificate-export", "certificate-export", 0],
    ["CER export", "public-certificate-export", "public-certificate-export", 0],
    ["thumbprint verify", "thumbprint-verify", "thumbprint-verify", 0],
    ["Root trust", "root-trust", "root-trust", 0],
    ["TrustedPublisher trust", "trusted-publisher-trust", "trusted-publisher-trust", 0],
    ["release", "release", "release", 1],
    ["signature verification", "signature-verification", "signature-verification", 1],
    ["bridge/predecessor verification", "bridge-predecessor-verification", "bridge-predecessor-verification", 1],
    ["artifact verification", "artifact-verification", "artifact-verification", 1],
    ["closed-bundle publication", "closed-bundle-publication", "closed-bundle-publication", 1],
    ["receipt writing", "receipt-writing", "receipt-writing", 1],
  ] as const)(
    "post-consumption failure at %s is bounded and cannot bypass cleanup",
    async (_name, failedStage, category, releaseInvocationCount) => {
      // Break caught: a thrown post-consumption stage must not unwind past the
      // independently continuing cleanup boundary or expose exception data.
      const result = await runController(await createFixture(), {
        failedStages: [failedStage],
      });

      expect(result.operations).toContain("CreateConsumedMarkerAtomic");
      const expectedCleanupTail = failedStage === "output-preservation"
        ? cleanupTail.filter((operation) => operation !== "RemoveGeneratedOutput")
        : ["closed-bundle-publication", "bridge-predecessor-verification", "artifact-verification"].includes(failedStage)
        ? [
          ...cleanupTail.slice(0, cleanupTail.indexOf("RemoveRuntime") + 1),
          "RemovePartialArtifactBundle",
          "RemovePartialArtifactBundle",
          ...cleanupTail.slice(cleanupTail.indexOf("RemoveRuntime") + 1),
        ]
        : cleanupTail;
      expect(result.operations.slice(result.operations.lastIndexOf("SettleDescendants"))).toEqual(expectedCleanupTail);
      expect(result.operations.filter((name) => name === "InvokeRelease")).toHaveLength(releaseInvocationCount);
      expect(result.operations.join(" ")).not.toMatch(/retry|resume|removeconsumed/i);
      expect(JSON.stringify(result)).not.toMatch(/unit-test-raw-output-path|secret-value|unit-test-private-key/i);
      if (failedStage === "receipt-writing") {
        expect(result).toMatchObject({ ok: false, error: "receipt-writing", receipt: null });
      } else {
        expect(result).toMatchObject({
          ok: true,
          result: {
            status: "FAIL",
            primaryCategory: category,
            cleanupCategories: [],
            releaseInvocationCount,
          },
          receipt: {
            status: "FAIL",
            primaryCategory: category,
            cleanupCategories: [],
            releaseInvocationCount,
          },
        });
      }
    },
  );

  it.each([
    ["descendant settlement", "descendant-settlement", "descendant-settlement"],
    ["environment clearing", "signing-environment-clear", "signing-environment-clear"],
    ["Root trust removal", "root-trust-removal", "root-trust-removal"],
    ["TrustedPublisher removal", "trusted-publisher-trust-removal", "trusted-publisher-trust-removal"],
    ["My-store removal", "my-certificate-removal", "my-certificate-removal"],
    ["CNG-key removal", "cng-key-removal", "cng-key-removal"],
    ["PFX removal", "pfx-removal", "pfx-removal"],
    ["CER removal", "cer-removal", "cer-removal"],
    ["runtime removal", "runtime-removal", "runtime-removal"],
    ["generated dist removal", "generated-dist-removal", "generated-dist-removal"],
    ["generated out removal", "generated-out-removal", "generated-out-removal"],
    ["recovery restore", "output-restoration", "output-restoration"],
    ["after-projection", "after-projection", "after-projection"],
  ] as const)(
    "cleanup continuation after %s failure attempts every later cleanup stage",
    async (_name, failedStage, cleanupCategory) => {
      // Break caught: replacing the per-operation catcher with one cleanup try/catch
      // would truncate this exact tail after the injected failure.
      const result = await runController(await createFixture(), {
        failedStages: [failedStage],
      });

      expect(result.operations.slice(result.operations.lastIndexOf("SettleDescendants"))).toEqual(cleanupTail);
      expect(result.result).toMatchObject({
        status: "FAIL",
        primaryCategory: "none",
        cleanupCategories: [cleanupCategory],
        releaseInvocationCount: 1,
      });
      expect(result.receipt).toEqual(result.result);
    },
  );

  it.each([
    ["release plus Root cleanup", ["release", "root-trust-removal"], "release", ["root-trust-removal"]],
    ["artifact verification plus output restore", ["artifact-verification", "output-restoration"], "artifact-verification", ["output-restoration"]],
  ] as const)(
    "cleanup continuation preserves separate dual-failure categories for %s",
    async (_name, failedStages, primaryCategory, cleanupCategories) => {
      const result = await runController(await createFixture(), { failedStages: [...failedStages] });
      const expectedTail = failedStages.includes("artifact-verification")
        ? [
          ...cleanupTail.slice(0, cleanupTail.indexOf("RemoveRuntime") + 1),
          "RemovePartialArtifactBundle",
          "RemovePartialArtifactBundle",
          ...cleanupTail.slice(cleanupTail.indexOf("RemoveRuntime") + 1),
        ]
        : cleanupTail;

      expect(result.result).toMatchObject({ status: "FAIL", primaryCategory, cleanupCategories });
      expect(result.operations.slice(result.operations.lastIndexOf("SettleDescendants"))).toEqual(expectedTail);
      expect(JSON.stringify(result)).not.toContain("unit-test-raw-output-path");
    },
  );

  it("output restoration returns exact pre-existing trees and never moves nested squirrel-vendor twice", async () => {
    // Break caught: preserving nested dist content independently, deleting by a
    // prefix, or omitting restoration changes the real byte projection.
    const fixture = await createFixture();
    const dist = join(fixture.manifest.repository.root, "dist");
    const out = join(fixture.manifest.repository.root, "out");
    const sibling = join(fixture.manifest.repository.root, "dist-unrelated");
    await mkdir(join(dist, "squirrel-vendor", "nested"), { recursive: true });
    await mkdir(out, { recursive: true });
    await mkdir(sibling, { recursive: true });
    await writeFile(join(dist, "squirrel-vendor", "nested", "payload.bin"), Buffer.from([0, 255, 16]));
    await writeFile(join(dist, "root.bin"), Buffer.from([1, 2, 3]));
    await writeFile(join(out, "read-only.txt"), "sentinel", "utf8");
    await chmod(join(out, "read-only.txt"), 0o444);
    await writeFile(join(sibling, "keep.txt"), "unrelated", "utf8");
    const beforeDist = await snapshotTree(dist);
    const beforeOut = await snapshotTree(out);
    const beforeSibling = await snapshotTree(sibling);

    const result = await runController(fixture, { realOutputEffects: true });

    expect(result.result).toMatchObject({ status: "PASS", cleanupCategories: [], residue: emptyResidue });
    expect(await snapshotTree(dist)).toEqual(beforeDist);
    expect(await snapshotTree(out)).toEqual(beforeOut);
    expect(await snapshotTree(sibling)).toEqual(beforeSibling);
    expect(result.operations.indexOf("CreateConsumedMarkerAtomic"))
      .toBeLessThan(result.operations.indexOf("PreserveOutputRoot"));
    expect(await pathExists(fixture.manifest.paths.consumedMarker)).toBe(true);
    expect(await pathExists(join(fixture.manifest.paths.artifactRoot, "artifact-manifest.json"))).toBe(true);
    expect(await pathExists(join(fixture.manifest.repository.root, runDirectory, "recovery"))).toBe(false);
  });

  it("output restoration leaves initially absent dist and out absent and preserves unrelated read-only siblings", async () => {
    const fixture = await createFixture();
    const sibling = join(fixture.manifest.repository.root, "out-unrelated");
    const sentinel = join(sibling, "read-only.txt");
    await mkdir(sibling, { recursive: true });
    await writeFile(sentinel, "unchanged", "utf8");
    await chmod(sentinel, 0o444);

    const result = await runController(fixture, { realOutputEffects: true });

    expect(result.result).toMatchObject({ status: "PASS", residue: emptyResidue });
    expect(await pathExists(join(fixture.manifest.repository.root, "dist"))).toBe(false);
    expect(await pathExists(join(fixture.manifest.repository.root, "out"))).toBe(false);
    expect(await readFile(sentinel, "utf8")).toBe("unchanged");
  });

  it.each([
    ["recovery state", "output-preservation-after-recovery-state", "RestoreOutputRoot:state-created"],
    ["throw before dist move", "output-preservation-before-dist-move", "PreserveOutputRoot:dist-move-declared"],
    ["dist move", "output-preservation-after-dist", "PreserveOutputRoot:dist-moved"],
    ["out move", "output-preservation-after-out", "PreserveOutputRoot:out-moved"],
  ] as const)(
    "partial preservation after %s restores exact real output bytes",
    async (_name, failedStage, mutationLabel) => {
      // Break caught: assigning preservation state only after the operation
      // returns loses a move that occurred before an exception.
      const fixture = await createFixture();
      const dist = join(fixture.manifest.repository.root, "dist");
      const out = join(fixture.manifest.repository.root, "out");
      await mkdir(join(dist, "squirrel-vendor"), { recursive: true });
      await mkdir(out, { recursive: true });
      await writeFile(join(dist, "payload.bin"), Buffer.from([0, 1, 255]));
      await writeFile(join(dist, "squirrel-vendor", "nested.bin"), Buffer.from([9, 8, 7]));
      await writeFile(join(out, "payload.bin"), Buffer.from([6, 5, 4]));
      const beforeDist = await snapshotTree(dist);
      const beforeOut = await snapshotTree(out);

      const result = await runController(fixture, {
        realOutputEffects: true,
        captureArguments: true,
        failedStages: [failedStage],
      });

      expect(result.result).toMatchObject({
        status: "FAIL",
        primaryCategory: "output-preservation",
        cleanupCategories: [],
      });
      expect(result.operationArguments).toContain(mutationLabel);
      expect(result.operationArguments).toContain("RestoreOutputRoot:state-created");
      expect(await snapshotTree(dist)).toEqual(beforeDist);
      expect(await snapshotTree(out)).toEqual(beforeOut);
      expect(await pathExists(join(fixture.manifest.repository.root, runDirectory, "recovery"))).toBe(false);
      expect(await pathExists(fixture.manifest.paths.consumedMarker)).toBe(true);
    },
  );

  it("partial preservation keeps both exact copies and fails restoration when original and recovery are ambiguous", async () => {
    // Break caught: deleting either exact copy in an ambiguous presence state can
    // destroy the only trustworthy pre-run output.
    const fixture = await createFixture();
    const dist = join(fixture.manifest.repository.root, "dist");
    const out = join(fixture.manifest.repository.root, "out");
    const recoveryDist = join(
      fixture.manifest.repository.root,
      runDirectory,
      "recovery",
      "dist",
    );
    await mkdir(dist, { recursive: true });
    await mkdir(out, { recursive: true });
    await writeFile(join(dist, "ambiguous.bin"), Buffer.from([3, 1, 4, 1, 5]));
    await writeFile(join(out, "unchanged.bin"), Buffer.from([2, 7, 1, 8]));
    const beforeDist = await snapshotTree(dist);
    const beforeOut = await snapshotTree(out);

    const result = await runController(fixture, {
      realOutputEffects: true,
      captureArguments: true,
      failedStages: ["output-preservation-ambiguous-dist"],
    });

    expect(result.result).toMatchObject({
      status: "FAIL",
      primaryCategory: "output-preservation",
      cleanupCategories: ["output-restoration"],
    });
    expect(result.operationArguments).toContain("RestoreOutputRoot:dist:original:recovery");
    expect(await snapshotTree(dist)).toEqual(beforeDist);
    expect(await snapshotTree(recoveryDist)).toEqual(beforeDist);
    expect(await snapshotTree(out)).toEqual(beforeOut);
    expect(await pathExists(fixture.manifest.paths.consumedMarker)).toBe(true);
  });

  it("partial preservation fails closed when retained moving state has neither exact output copy", async () => {
    // Break caught: treating neither-present as restored can silently turn an
    // uncertain move into success and permit cleanup to conceal lost output.
    const fixture = await createFixture();
    const dist = join(fixture.manifest.repository.root, "dist");
    const recoveryDist = join(
      fixture.manifest.repository.root,
      runDirectory,
      "recovery",
      "dist",
    );

    const result = await runController(fixture, {
      realOutputEffects: true,
      captureArguments: true,
      failedStages: ["output-preservation-neither-dist"],
    });

    expect(result.result).toMatchObject({
      status: "FAIL",
      primaryCategory: "output-preservation",
      cleanupCategories: ["output-restoration"],
    });
    expect(result.operationArguments).toContain(
      "PreserveOutputRoot:dist-move-declared:no-original:no-recovery",
    );
    expect(result.operationArguments).toContain(
      "RestoreOutputRoot:dist:no-original:no-recovery",
    );
    expect(result.operations.slice(result.operations.indexOf("RestoreOutputRoot"))).toEqual([
      "RestoreOutputRoot",
      "GetAfterProjection",
      "WriteReceiptAtomic",
    ]);
    expect(await pathExists(dist)).toBe(false);
    expect(await pathExists(recoveryDist)).toBe(false);
    expect(await pathExists(fixture.manifest.paths.consumedMarker)).toBe(true);
  });

  it.each([
    ["certificate create", "certificate-create", ["RemoveTrust:Root:thumbprint", "RemoveTrust:TrustedPublisher:thumbprint", "RemoveCertificate:My:thumbprint", "RemoveCngKey:known", "RemoveExactFile:pfx", "RemoveExactFile:cer"]],
    ["private-key open", "private-key-open", ["RemoveTrust:Root:thumbprint", "RemoveTrust:TrustedPublisher:thumbprint", "RemoveCertificate:My:thumbprint", "RemoveCngKey:known", "RemoveExactFile:pfx", "RemoveExactFile:cer"]],
    ["PFX export", "certificate-export", ["RemoveTrust:Root:thumbprint", "RemoveTrust:TrustedPublisher:thumbprint", "RemoveCertificate:My:thumbprint", "RemoveCngKey:known", "RemoveExactFile:pfx", "RemoveExactFile:cer"]],
    ["CER export", "public-certificate-export", ["RemoveTrust:Root:thumbprint", "RemoveTrust:TrustedPublisher:thumbprint", "RemoveCertificate:My:thumbprint", "RemoveCngKey:known", "RemoveExactFile:pfx", "RemoveExactFile:cer"]],
    ["thumbprint verification", "thumbprint-verify", ["RemoveTrust:Root:thumbprint", "RemoveTrust:TrustedPublisher:thumbprint", "RemoveCertificate:My:thumbprint", "RemoveCngKey:known", "RemoveExactFile:pfx", "RemoveExactFile:cer"]],
  ] as const)(
    "partial certificate preparation after %s retains only exact known cleanup identity",
    async (_name, failedStage, expectedIdentity) => {
      // Break caught: replacing the mutable preparation state with the operation
      // return value makes every partial identity null after a thrown stage.
      const fixture = await createFixture();
      const result = await runController(fixture, {
        captureArguments: true,
        failedStages: [failedStage],
      });
      const identity = (result.operationArguments ?? []).filter((entry) =>
        /^(RemoveTrust:|RemoveCertificate|RemoveCngKey|RemoveExactFile)/.test(entry)
      );

      expect(result.result).toMatchObject({ status: "FAIL", primaryCategory: failedStage });
      expect(identity).toEqual(expectedIdentity);
      expect(await pathExists(fixture.manifest.paths.pfx)).toBe(false);
      expect(await pathExists(fixture.manifest.paths.cer)).toBe(false);
      expect(JSON.stringify(result)).not.toMatch(/unit-test-private-key|intentarc-signed-once-|test-pfx|test-cer/i);
    },
  );

  it.each([
    ["before promotion", "closed-bundle-publication-after-staging-write", "PublishClosedArtifactBundle:staging-written"],
    ["after promotion", "closed-bundle-publication-after-final-move", "PublishClosedArtifactBundle:final-promoted"],
  ] as const)("bundle rollback removes real partial publication %s", async (_name, failedStage, mutationLabel) => {
    // Break caught: a publication operation that mutates staging before throwing
    // must not leave staging or promote an unintended final bundle.
    const fixture = await createFixture();
    const stagingRoot = `${fixture.manifest.paths.artifactRoot}.staging`;
    const result = await runController(fixture, {
      realOutputEffects: true,
      captureArguments: true,
      failedStages: [failedStage],
    });

    expect(result.result).toMatchObject({
      status: "FAIL",
      primaryCategory: "closed-bundle-publication",
      cleanupCategories: [],
    });
    expect(result.operationArguments).toContain(mutationLabel);
    expect(result.operationArguments.filter((argument) =>
      argument.startsWith("RemovePartialArtifactBundle:")
    )).toEqual([
      "RemovePartialArtifactBundle:staging",
      "RemovePartialArtifactBundle:final",
    ]);
    expect(await pathExists(stagingRoot)).toBe(false);
    expect(await pathExists(fixture.manifest.paths.artifactRoot)).toBe(false);
    expect(JSON.stringify(result.result)).not.toContain(stagingRoot);
  });

  it("cancellation observed after promotion retains verified bundle evidence", async () => {
    const fixture = await createFixture();
    const result = await runController(fixture, {
      realOutputEffects: true,
      cancellationAfterPublication: true,
    });

    expect(result.result).toMatchObject({
      status: "FAIL",
      primaryCategory: "interruption",
      highestCompletedState: "cleaned",
      artifactManifestSha256: "d".repeat(64),
    });
    expect(result.operations).not.toContain("RemovePartialArtifactBundle");
    expect(await pathExists(fixture.manifest.paths.artifactRoot)).toBe(true);
  });

  it.each([
    ["staging", "closed-bundle-publication-after-staging-write", "artifact-bundle-staging-rollback"],
    ["final", "closed-bundle-publication-after-final-move", "artifact-bundle-final-rollback"],
  ] as const)(
    "cleanup continuation after artifact %s rollback failure reaches receipt",
    async (_label, publicationFailure, rollbackFailure) => {
      const result = await runController(await createFixture(), {
        realOutputEffects: true,
        captureArguments: true,
        failedStages: [publicationFailure, rollbackFailure],
      });
      const firstRollback = result.operations.indexOf("RemovePartialArtifactBundle");

      expect(result.result).toMatchObject({
        status: "FAIL",
        primaryCategory: "closed-bundle-publication",
        cleanupCategories: [rollbackFailure, "after-projection"],
      });
      expect(result.operations.slice(firstRollback)).toEqual([
        "RemovePartialArtifactBundle",
        "RemovePartialArtifactBundle",
        "RemoveGeneratedOutput",
        "RemoveGeneratedOutput",
        "RestoreOutputRoot",
        "GetAfterProjection",
        "WriteReceiptAtomic",
      ]);
      expect(result.operationArguments.filter((argument) =>
        argument.startsWith("RemovePartialArtifactBundle:")
      )).toEqual([
        "RemovePartialArtifactBundle:staging",
        "RemovePartialArtifactBundle:final",
      ]);
      expect(JSON.stringify(result)).not.toContain("unit-test-raw-output-path");
    },
  );

  it("exact cleanup identity records CurrentUser Root before TrustedPublisher and dist before out", async () => {
    const result = await runController(await createFixture(), { captureArguments: true });

    expect(result.result).toMatchObject({ status: "PASS", cleanupCategories: [] });
    expect(result.operationArguments).toEqual([
      "AddTrust:Root",
      "AddTrust:TrustedPublisher",
      "RemoveTrust:Root:thumbprint",
      "RemoveTrust:TrustedPublisher:thumbprint",
      "RemoveCertificate:My:thumbprint",
      "RemoveCngKey:known",
      "RemoveExactFile:pfx",
      "RemoveExactFile:cer",
      "RemoveRuntime:runtime",
      "RemoveGeneratedOutput:dist",
      "RemoveGeneratedOutput:out",
      "RestoreOutputRoot:recovery",
      "RestoreOutputRoot:state-not-created",
    ]);
  });

  it.each(Object.keys(emptyResidue) as ResidueKey[])(
    "residue proof fails independently for nonzero %s",
    async (residueKey) => {
      // Break caught: ignoring any one run-owned residue counter must turn this
      // otherwise successful consumed run into PASS.
      const result = await runController(await createFixture(), {
        residueOverrides: { [residueKey]: 1 },
      });

      expect(result.result).toMatchObject({
        status: "FAIL",
        primaryCategory: "none",
        cleanupCategories: ["residue-proof"],
        residue: { ...emptyResidue, [residueKey]: 1 },
      });
      expect(result.receipt).toEqual(result.result);
    },
  );

  it("cleanup continuation categorizes successful release plus residue proof failure", async () => {
    const result = await runController(await createFixture(), {
      residueOverrides: { recoveryDirectory: 1 },
    });

    expect(result.result).toMatchObject({
      status: "FAIL",
      primaryCategory: "none",
      cleanupCategories: ["residue-proof"],
      releaseInvocationCount: 1,
    });
  });

  it("bounded receipt has exactly the v3 terminal schema after cleanup and projection", async () => {
    // Break caught: adding internal identities or writing before final projection
    // changes the exact public receipt boundary.
    const fixture = await createFixture();
    const result = await runController(fixture);
    const receipt = result.receipt!;

    expect(Object.keys(receipt)).toEqual(receiptKeys);
    expect(receipt).toMatchObject({
      schema: "intentarc.signed-release-receipt/v3",
      runId,
      commit: fixture.manifest.repository.commit,
      manifestSha256: fixture.expectedSha256,
      status: "PASS",
      highestCompletedState: "cleaned",
      primaryCategory: "none",
      cleanupCategories: [],
      releaseInvocationCount: 1,
      nestedMakeInvocationCount: 1,
      forbiddenLifecycleInvocationCount: 0,
      externalPublicationInvocationCount: 0,
      bridgeDiagnosticInvocationCount: 5,
      residue: emptyResidue,
      artifactManifestSha256: "d".repeat(64),
    });
    expect(Date.parse(receipt.startedAtUtc as string)).not.toBeNaN();
    expect(Date.parse(receipt.completedAtUtc as string)).not.toBeNaN();
    expect(result.operations.at(-2)).toBe("GetAfterProjection");
    expect(result.operations.at(-1)).toBe("WriteReceiptAtomic");
    expect(JSON.stringify(receipt)).not.toMatch(/unit-test-private-key|intentarc-signed-once-|secret|stdout|stderr|INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT/i);
  });

  it.each([
    ["release failure", { failedStages: ["release"] }],
    ["cleanup failure", { failedStages: ["root-trust-removal"] }],
    ["nonzero external-publication count", { releaseResultSource: "[ordered]@{ releaseInvocations = 1; nestedMakeInvocations = 1; forbiddenLifecycleCount = 0; externalPublicationCount = 1 }" }],
  ])("writes exact v3 keys and types on the %s terminal path", async (_name, options) => {
    // Break caught: failure-only projection branches can omit the new count,
    // coerce an integer, or leak a branch-specific key even when PASS is exact.
    const fixture = await createFixture();
    const result = await runController(fixture, options);
    const receiptPath = join(fixture.manifest.paths.receipt, "..", "contract-failure.json");

    expect(result.receipt).not.toBeNull();
    expectExactReceiptContract(result.receipt!);
    expect(result.receipt).toEqual(result.result);
    expect(await runReceiptWriter(receiptPath, result.receipt!)).toBe("accepted");
    expect(JSON.parse(await readFile(receiptPath, "utf8"))).toEqual(result.receipt);
  });

  it.each([
    ["legacy v2 schema", (receipt: Record<string, unknown>) => { receipt.schema = "intentarc.signed-release-receipt/v2"; }],
    ["an unknown key", (receipt: Record<string, unknown>) => { receipt.unexpected = 0; }],
    ["a string release count", (receipt: Record<string, unknown>) => { receipt.releaseInvocationCount = "1"; }],
    ["a fractional nested make count", (receipt: Record<string, unknown>) => { receipt.nestedMakeInvocationCount = 1.5; }],
    ["a Boolean forbidden lifecycle count", (receipt: Record<string, unknown>) => { receipt.forbiddenLifecycleInvocationCount = false; }],
    ["a string external-publication count", (receipt: Record<string, unknown>) => { receipt.externalPublicationInvocationCount = "0"; }],
    ["a fractional bridge diagnostic count", (receipt: Record<string, unknown>) => { receipt.bridgeDiagnosticInvocationCount = 0.5; }],
  ])("receipt writer rejects %s before creating output", async (_name, mutate) => {
    // Break caught: serializing an unchecked terminal object can persist a
    // legacy, extended, or non-integer receipt outside the reviewed contract.
    const fixture = await createFixture();
    const receiptPath = join(fixture.manifest.paths.receipt, "..", `invalid-${Date.now()}.json`);
    const receipt = validReceipt();
    mutate(receipt);

    expect(await runReceiptWriter(receiptPath, receipt)).toBe("receipt-writing");
    expect(await pathExists(receiptPath)).toBe(false);
  });

  it.each([
    ["a different run ID", (receipt: Record<string, unknown>) => { receipt.runId = "intentarc-phase1-signed-20260830-01"; }],
    ["an overlong run ID", (receipt: Record<string, unknown>) => { receipt.runId = "r".repeat(129); }],
    ["an absolute-path primary category", (receipt: Record<string, unknown>) => { receipt.primaryCategory = "C:\\Users\\someone\\secret.txt"; }],
    ["an environment-bearing primary category", (receipt: Record<string, unknown>) => { receipt.primaryCategory = "NODE_OPTIONS=--require secret-loader"; }],
    ["a raw exception primary category", (receipt: Record<string, unknown>) => { receipt.primaryCategory = "System.InvalidOperationException: raw error"; }],
    ["an overlong primary category", (receipt: Record<string, unknown>) => { receipt.primaryCategory = "x".repeat(129); }],
    ["an absolute-path cleanup category", (receipt: Record<string, unknown>) => { receipt.cleanupCategories = ["C:\\temp\\raw.log"]; }],
    ["an overlong cleanup category", (receipt: Record<string, unknown>) => { receipt.cleanupCategories = ["x".repeat(129)]; }],
    ["a malformed start timestamp", (receipt: Record<string, unknown>) => { receipt.startedAtUtc = "not-a-timestamp"; }],
    ["an offset completion timestamp", (receipt: Record<string, unknown>) => { receipt.completedAtUtc = "2026-08-30T01:00:01.0000000+01:00"; }],
    ["an overlong completion timestamp", (receipt: Record<string, unknown>) => { receipt.completedAtUtc = `${receipt.completedAtUtc}trailing`; }],
  ])("production receipt persistence rejects %s", async (_name, mutate) => {
    // Break caught: nonblank free-form strings can carry paths, ambient
    // configuration, raw failures, or noncanonical time evidence into receipts.
    const fixture = await createFixture();
    const receipt = validReceipt();
    mutate(receipt);

    expect(await runProductionReceiptWriter(fixture.manifest.paths.receipt, receipt)).toBe("receipt-writing");
    expect(await pathExists(fixture.manifest.paths.receipt)).toBe(false);
  });

  it("bounded receipt atomic writer leaves no temp sibling and refuses replacement", async () => {
    const fixture = await createFixture();
    const receiptPath = fixture.manifest.paths.receipt;
    const receipt = validReceipt();
    const command = [
      "$ErrorActionPreference = 'Stop'",
      "$ProgressPreference = 'SilentlyContinue'",
      `. '${escapePowerShell(controllerScriptPath)}'`,
      `$receipt = '${escapePowerShell(JSON.stringify(receipt))}' | ConvertFrom-Json`,
      `Write-IntentArcSignedReleaseReceiptAtomic -LiteralPath '${escapePowerShell(receiptPath)}' -Receipt $receipt -ExpectedRunId '${runId}'`,
      "$second = try { Write-IntentArcSignedReleaseReceiptAtomic -LiteralPath '" + escapePowerShell(receiptPath) + "' -Receipt $receipt -ExpectedRunId '" + runId + "'; 'accepted' } catch { $_.Exception.Message }",
      "$second | ConvertTo-Json -Compress",
    ].join("\r\n");
    const writer = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(command)],
      { encoding: "utf8", env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } },
    );
    const directoryEntries = await readdir(join(fixture.manifest.repository.root, runDirectory));

    expect(writer.stderr).toBe("");
    expect(JSON.parse(writer.stdout)).toBe("receipt-writing");
    expect(JSON.parse(await readFile(receiptPath, "utf8"))).toEqual(receipt);
    expect(directoryEntries.filter((entry) => entry.startsWith("receipt.json.") || entry.endsWith(".tmp"))).toEqual([]);
    expect(JSON.parse(await readFile(receiptPath, "utf8"))).toEqual(receipt);
  });

  it("receipt promotion re-confirms its canonical temp immediately before the final move", async () => {
    // Break caught: omitting the post-presence-probe confirmation allows a stale
    // canonical decision to authorize the final receipt move.
    const fixture = await createFixture();
    const receiptPath = fixture.manifest.paths.receipt;
    const command = [
      "$ErrorActionPreference = 'Stop'",
      "$ProgressPreference = 'SilentlyContinue'",
      `. '${escapePowerShell(controllerScriptPath)}'`,
      "$script:confirmations = 0",
      "function Confirm-IntentArcValidatedCleanupTarget { param($LiteralRoot, $CanonicalTarget); $script:confirmations++; if ($script:confirmations -eq 3) { return 'cleanup-target-invalid' }; return 'cleanup-target-contained' }",
      `$receipt = '${escapePowerShell(JSON.stringify(validReceipt()))}' | ConvertFrom-Json`,
      `$outcome = try { Write-IntentArcSignedReleaseReceiptAtomic -LiteralPath '${escapePowerShell(receiptPath)}' -Receipt $receipt -ExpectedRunId '${runId}'; 'accepted' } catch { $_.Exception.Message }`,
      "[ordered]@{ outcome = $outcome; confirmations = $script:confirmations } | ConvertTo-Json -Compress",
    ].join("\r\n");
    const writer = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(command)],
      { encoding: "utf8", env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } },
    );

    expect(writer.stderr).toBe("");
    expect(JSON.parse(writer.stdout)).toEqual({
      outcome: "receipt-writing",
      confirmations: 4,
    });
    expect(await pathExists(receiptPath)).toBe(false);
    expect((await readdir(join(fixture.manifest.repository.root, runDirectory)))
      .some((entry) => entry.endsWith(".tmp"))).toBe(false);
  });

  it("receipt disposal failure closes on bounded retry and removes the real temp sibling", async () => {
    // Break caught: a fake stream with no filesystem handle made temp cleanup
    // vacuous; this wrapper keeps a real exclusive handle until the retry.
    const fixture = await createFixture();
    const receiptPath = fixture.manifest.paths.receipt;
    const command = [
      "class IntentArcThrowingDisposeStream {",
      "  static [int] $DisposeCalls = 0",
      "  [IO.FileStream] $Inner",
      "  IntentArcThrowingDisposeStream([string] $Path) { $this.Inner = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None) }",
      "  [void] Write([byte[]] $Bytes, [int] $Offset, [int] $Count) { $this.Inner.Write($Bytes,$Offset,$Count) }",
      "  [void] Flush([bool] $FlushToDisk) { $this.Inner.Flush($FlushToDisk) }",
      "  [void] Dispose() { [IntentArcThrowingDisposeStream]::DisposeCalls++; if ([IntentArcThrowingDisposeStream]::DisposeCalls -eq 1) { throw 'sensitive-disposal-detail-42' }; $this.Inner.Dispose() }",
      "}",
      "$ErrorActionPreference = 'Stop'",
      "$ProgressPreference = 'SilentlyContinue'",
      `. '${escapePowerShell(controllerScriptPath)}'`,
      "$openFile = { param($LiteralPath); return [IntentArcThrowingDisposeStream]::new($LiteralPath) }",
      `$receipt = '${escapePowerShell(JSON.stringify(validReceipt()))}' | ConvertFrom-Json`,
      `$outcome = try { Write-IntentArcSignedReleaseReceiptAtomic -LiteralPath '${escapePowerShell(receiptPath)}' -Receipt $receipt -ExpectedRunId '${runId}' -OpenFile $openFile; 'accepted' } catch { $_.Exception.Message }`,
      `$temporaryCount = @([IO.Directory]::GetFiles('${escapePowerShell(join(fixture.manifest.repository.root, runDirectory))}', '*.tmp', [IO.SearchOption]::TopDirectoryOnly)).Count`,
      "[ordered]@{ outcome = $outcome; disposeCalls = [IntentArcThrowingDisposeStream]::DisposeCalls; temporaryCount = $temporaryCount } | ConvertTo-Json -Compress",
    ].join("\r\n");
    const writer = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(command)],
      { encoding: "utf8", env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } },
    );

    expect(writer.stderr).toBe("");
    expect(JSON.parse(writer.stdout)).toEqual({ outcome: "receipt-writing", disposeCalls: 2, temporaryCount: 0 });
    expect(await pathExists(receiptPath)).toBe(false);
  });

  it.each([
    ["string releaseInvocations", "[ordered]@{ releaseInvocations = '1'; nestedMakeInvocations = 1; forbiddenLifecycleCount = 0; externalPublicationCount = 0 }"],
    ["Boolean releaseInvocations", "[ordered]@{ releaseInvocations = $true; nestedMakeInvocations = 1; forbiddenLifecycleCount = 0; externalPublicationCount = 0 }"],
    ["negative releaseInvocations", "[ordered]@{ releaseInvocations = -1; nestedMakeInvocations = 1; forbiddenLifecycleCount = 0; externalPublicationCount = 0 }"],
    ["fractional releaseInvocations", "[ordered]@{ releaseInvocations = 1.5; nestedMakeInvocations = 1; forbiddenLifecycleCount = 0; externalPublicationCount = 0 }"],
    ["oversized releaseInvocations", "[ordered]@{ releaseInvocations = 2147483648; nestedMakeInvocations = 1; forbiddenLifecycleCount = 0; externalPublicationCount = 0 }"],
    ["zero releaseInvocations", "[ordered]@{ releaseInvocations = 0; nestedMakeInvocations = 1; forbiddenLifecycleCount = 0; externalPublicationCount = 0 }"],
    ["missing releaseInvocations", "[ordered]@{ nestedMakeInvocations = 1; forbiddenLifecycleCount = 0; externalPublicationCount = 0 }"],
    ["string nestedMakeInvocations", "[ordered]@{ releaseInvocations = 1; nestedMakeInvocations = '1'; forbiddenLifecycleCount = 0; externalPublicationCount = 0 }"],
    ["Boolean nestedMakeInvocations", "[ordered]@{ releaseInvocations = 1; nestedMakeInvocations = $true; forbiddenLifecycleCount = 0; externalPublicationCount = 0 }"],
    ["negative nestedMakeInvocations", "[ordered]@{ releaseInvocations = 1; nestedMakeInvocations = -1; forbiddenLifecycleCount = 0; externalPublicationCount = 0 }"],
    ["fractional nestedMakeInvocations", "[ordered]@{ releaseInvocations = 1; nestedMakeInvocations = 1.5; forbiddenLifecycleCount = 0; externalPublicationCount = 0 }"],
    ["oversized nestedMakeInvocations", "[ordered]@{ releaseInvocations = 1; nestedMakeInvocations = 2147483648; forbiddenLifecycleCount = 0; externalPublicationCount = 0 }"],
    ["zero nestedMakeInvocations", "[ordered]@{ releaseInvocations = 1; nestedMakeInvocations = 0; forbiddenLifecycleCount = 0; externalPublicationCount = 0 }"],
    ["missing nestedMakeInvocations", "[ordered]@{ releaseInvocations = 1; forbiddenLifecycleCount = 0; externalPublicationCount = 0 }"],
    ["string forbiddenLifecycleCount", "[ordered]@{ releaseInvocations = 1; nestedMakeInvocations = 1; forbiddenLifecycleCount = '0'; externalPublicationCount = 0 }"],
    ["Boolean forbiddenLifecycleCount", "[ordered]@{ releaseInvocations = 1; nestedMakeInvocations = 1; forbiddenLifecycleCount = $false; externalPublicationCount = 0 }"],
    ["negative forbiddenLifecycleCount", "[ordered]@{ releaseInvocations = 1; nestedMakeInvocations = 1; forbiddenLifecycleCount = -1; externalPublicationCount = 0 }"],
    ["fractional forbiddenLifecycleCount", "[ordered]@{ releaseInvocations = 1; nestedMakeInvocations = 1; forbiddenLifecycleCount = 0.5; externalPublicationCount = 0 }"],
    ["oversized forbiddenLifecycleCount", "[ordered]@{ releaseInvocations = 1; nestedMakeInvocations = 1; forbiddenLifecycleCount = 2147483648; externalPublicationCount = 0 }"],
    ["missing forbiddenLifecycleCount", "[ordered]@{ releaseInvocations = 1; nestedMakeInvocations = 1; externalPublicationCount = 0 }"],
    ["string externalPublicationCount", "[ordered]@{ releaseInvocations = 1; nestedMakeInvocations = 1; forbiddenLifecycleCount = 0; externalPublicationCount = '0' }"],
    ["Boolean externalPublicationCount", "[ordered]@{ releaseInvocations = 1; nestedMakeInvocations = 1; forbiddenLifecycleCount = 0; externalPublicationCount = $false }"],
    ["negative externalPublicationCount", "[ordered]@{ releaseInvocations = 1; nestedMakeInvocations = 1; forbiddenLifecycleCount = 0; externalPublicationCount = -1 }"],
    ["fractional externalPublicationCount", "[ordered]@{ releaseInvocations = 1; nestedMakeInvocations = 1; forbiddenLifecycleCount = 0; externalPublicationCount = 0.5 }"],
    ["oversized externalPublicationCount", "[ordered]@{ releaseInvocations = 1; nestedMakeInvocations = 1; forbiddenLifecycleCount = 0; externalPublicationCount = 2147483648 }"],
    ["missing externalPublicationCount", "[ordered]@{ releaseInvocations = 1; nestedMakeInvocations = 1; forbiddenLifecycleCount = 0 }"],
    ["an extra counter", "[ordered]@{ releaseInvocations = 1; nestedMakeInvocations = 1; forbiddenLifecycleCount = 0; externalPublicationCount = 0; unexpected = 0 }"],
  ])("release counter contract rejects %s and cleans up with a bounded receipt", async (_name, releaseResultSource) => {
    // Break caught: PowerShell must not coerce an untrusted operation counter
    // before deciding whether the single-release ceiling was respected.
    const result = await runController(await createFixture(), { releaseResultSource });
    const expectedFailure = {
      status: "FAIL",
      primaryCategory: "release-result-invalid",
      highestCompletedState: "cleaned",
      cleanupCategories: [],
      releaseInvocationCount: 1,
      nestedMakeInvocationCount: 0,
      forbiddenLifecycleInvocationCount: 0,
      residue: emptyResidue,
    };

    expect(result.ok).toBe(true);
    expect(result.result).toMatchObject(expectedFailure);
    expect(result.receipt).toEqual(result.result);
    expect(result.operations.slice(result.operations.indexOf("InvokeRelease") + 1)).toEqual([
      "SettleDescendants",
      "ClearSigningEnvironment",
      "RemoveTrust",
      "RemoveTrust",
      "RemoveCertificate",
      "RemoveCngKey",
      "RemoveExactFile",
      "RemoveExactFile",
      "RemoveRuntime",
      "RemoveGeneratedOutput",
      "RemoveGeneratedOutput",
      "RestoreOutputRoot",
      "GetAfterProjection",
      "WriteReceiptAtomic",
    ]);
    expect(result.operations).not.toContain("VerifyRelease");
    expect(result.operations).not.toContain("PublishClosedArtifactBundle");
  });

  it.each([
    ["dirty Git status", { repositoryClean: false }, "repository-dirty"],
    ["the wrong commit", { repositoryCommit: "c".repeat(40) }, "repository-commit"],
    ["a changed bound file hash", { fileHash: "c".repeat(64) }, "bound-file-hash"],
    ["a changed release executable binding", { executionBindingOverrides: { releaseExecutableSha256: "f".repeat(64) } }, "execution-input-binding"],
    ["a missing artifacts parent", { executionBindingOverrides: { artifactParentReady: false } }, "execution-input-binding"],
    ["an unready repository package bin", { executionBindingOverrides: { packageBinReady: false } }, "execution-input-binding"],
    ["an existing marker", { beforeOverrides: { consumedMarker: 1 } }, "attempt-already-consumed"],
    ["an existing exact subject", { beforeOverrides: { myCertificate: 1 } }, "preflight-residue"],
    ["an existing exact key", { beforeOverrides: { cngKey: 1 } }, "preflight-residue"],
    ["an existing PFX", { beforeOverrides: { pfx: 1 } }, "preflight-residue"],
    ["an existing CER", { beforeOverrides: { cer: 1 } }, "preflight-residue"],
    ["an existing runtime", { beforeOverrides: { runtime: 1 } }, "preflight-residue"],
    ["an existing artifact bundle", { beforeOverrides: { artifactRoot: 1 } }, "preflight-residue"],
    ["an active signing environment", { beforeOverrides: { signingEnvironment: 1 } }, "signing-environment-active"],
    ["an output projection failure", { outputProjectionThrows: true }, "output-projection-invalid"],
  ] satisfies Array<[string, ControllerOptions, string]>) (
    "preflight refusal for %s records no mutation and writes no receipt",
    async (_name, options, category) => {
      // Break caught: a refused observation must never cross a mutation boundary.
      const result = await runController(await createFixture(), options);

      expect(result.ok).toBe(true);
      expect(result.result).toEqual({
        status: "REFUSED",
        primaryCategory: category,
        highestCompletedState: "validated",
        releaseInvocations: 0,
        nestedMakeInvocations: 0,
        forbiddenLifecycleCount: 0,
        externalPublicationCount: 0,
        markerConsumed: false,
      });
      expect(result.operations.filter((name) => controllerMutations.includes(name))).toEqual([]);
      expect(result.receipt).toBeNull();
      expect(JSON.stringify(result.result)).not.toContain("unit-test-raw-output-path");
    },
  );

  it("attempt consumption stops after losing the atomic marker race", async () => {
    // Break caught: treating a failed CreateNew result as success would allow a
    // second release attempt to preserve outputs or prepare a certificate.
    const result = await runController(await createFixture(), { markerCreated: false });

    expect(result).toEqual({
      ok: true,
      result: {
        status: "REFUSED",
        primaryCategory: "attempt-consumption-race",
        highestCompletedState: "validated",
        releaseInvocations: 0,
        nestedMakeInvocations: 0,
        forbiddenLifecycleCount: 0,
        externalPublicationCount: 0,
        markerConsumed: false,
      },
      operations: [
        "BindExecutionInputs",
        "GetRepositoryState",
        "GetTrackedFileInventory",
        "GetFileHash",
        "GetRuntimeClosure",
        "GetBeforeProjection",
        "CreateConsumedMarkerAtomic",
      ],
      receipt: null,
    });
  });

  it("refuses an incomplete bound Git tracked-file inventory before consuming the marker", async () => {
    // Break caught: a subset inventory would leave an executable tracked source
    // outside the manifest hash closure.
    const result = await runController(await createFixture(), { trackedFiles: [] });

    expect(result.result).toMatchObject({
      status: "REFUSED",
      primaryCategory: "tracked-file-inventory",
      highestCompletedState: "validated",
      markerConsumed: false,
    });
    expect(result.operations).not.toContain("CreateConsumedMarkerAtomic");
  });

  it("refuses a case-distinct bound Git tracked path before consuming the marker", async () => {
    // Break caught: case-folded inventory equality can authorize a bytewise
    // different Git path record than the manifest's ordinal path closure.
    const fixture = await createFixture();
    const trackedPath = fixture.manifest.files[0]!.path.replace("package.json", "PACKAGE.json");
    const result = await runController(fixture, { trackedFiles: [trackedPath] });

    expect(result.result).toMatchObject({
      status: "REFUSED",
      primaryCategory: "tracked-file-inventory",
      highestCompletedState: "validated",
      markerConsumed: false,
    });
    expect(result.operations).not.toContain("CreateConsumedMarkerAtomic");
  });

  it("refuses a non-ASCII case-distinct bound Git tracked path before consuming the marker", async () => {
    // Break caught: culture or case-insensitive path equality can collapse
    // distinct Unicode Git records before their manifest hashes are checked.
    const fixture = await createFixture((manifest) => {
      manifest.files[0]!.path = join(manifest.repository.root, "résumé.ts");
    });
    const result = await runController(fixture, {
      trackedFiles: [join(fixture.manifest.repository.root, "RÉSUMÉ.ts")],
    });

    expect(result.result).toMatchObject({
      status: "REFUSED",
      primaryCategory: "tracked-file-inventory",
      highestCompletedState: "validated",
      markerConsumed: false,
    });
    expect(result.operations).not.toContain("CreateConsumedMarkerAtomic");
  });
});
