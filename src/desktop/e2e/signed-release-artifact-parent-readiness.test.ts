import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const readinessScriptPath = join(process.cwd(), "scripts", "signed-release-artifact-parent-readiness.ps1");
const windowsOnly = process.platform === "win32" ? describe : describe.skip;
const temporaryRoots: string[] = [];
const artifactLeaf = "intentarc-phase1-signed-20260830-03";

const escapePowerShell = (value: string) => value.replaceAll("'", "''");
const encodePowerShell = (source: string) => Buffer.from(source, "utf16le").toString("base64");
const exists = async (path: string) => lstat(path).then(() => true).catch(() => false);

const createFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "intentarc-artifact-parent-readiness-"));
  temporaryRoots.push(root);
  const repositoryRoot = join(root, "repository");
  const artifactRoot = join(repositoryRoot, ".superpowers", "artifacts", artifactLeaf);
  await mkdir(join(repositoryRoot, ".superpowers"), { recursive: true });
  return { root, repositoryRoot, artifactRoot, artifactParent: join(repositoryRoot, ".superpowers", "artifacts") };
};

const runReadiness = async (repositoryRoot: string, artifactRoot: string, extra: string[] = []) =>
  execFileAsync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-File", readinessScriptPath,
    "-RepositoryRoot", repositoryRoot,
    "-ArtifactRoot", artifactRoot,
    ...extra,
  ], {
    encoding: "utf8",
    env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR },
    maxBuffer: 32 * 1024,
    timeout: 30_000,
    windowsHide: true,
  });

const runReadinessFunction = async (argumentsVector: string) => {
  const command = [
    "$ProgressPreference = 'SilentlyContinue'",
    `. '${escapePowerShell(readinessScriptPath)}'`,
    `$result = Initialize-IntentArcSignedReleaseArtifactParent -ArgumentsVector @(${argumentsVector})`,
    "$result | ConvertTo-Json -Compress",
  ].join("\r\n");
  return execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(command)], {
    encoding: "utf8", env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR },
  });
};

const expectRefusal = async (invoke: Promise<unknown>, category: string) => {
  const failure = await invoke.catch((error: { code?: number; stdout?: string; stderr?: string }) => error);
  expect(failure).toMatchObject({ code: 1, stderr: "" });
  const parsed = JSON.parse((failure as { stdout: string }).stdout);
  expect(parsed).toEqual({
    schema: "intentarc.signed-release-artifact-parent-readiness/v1",
    status: "REFUSED",
    category,
  });
  expect(Object.keys(parsed).sort()).toEqual(["category", "schema", "status"]);
  expect((failure as { stdout: string }).stdout).not.toMatch(/[A-Za-z]:\\|secret|environment|exception/i);
};

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

windowsOnly("signed release artifact-parent readiness", () => {
  it("creates only the ordinary artifact parent and reports the exact dormant success contract", async () => {
    // Break caught: creating the final/staging run path or emitting a broader
    // result would turn preparation into an authorization-relevant mutation.
    const { repositoryRoot, artifactRoot, artifactParent } = await createFixture();

    const result = await runReadiness(repositoryRoot, artifactRoot);

    expect(JSON.parse(result.stdout)).toEqual({
      schema: "intentarc.signed-release-artifact-parent-readiness/v1",
      status: "PASS",
      artifactParentReady: true,
    });
    expect(result.stderr).toBe("");
    expect((await lstat(artifactParent)).isDirectory()).toBe(true);
    expect(await exists(artifactRoot)).toBe(false);
    expect(await exists(`${artifactRoot}.staging`)).toBe(false);
  });

  it("passes idempotently when the exact ordinary artifact parent already exists", async () => {
    // Break caught: treating the intended parent as run state would prevent a
    // safe re-run before any controller authorization.
    const { repositoryRoot, artifactRoot, artifactParent } = await createFixture();
    await mkdir(artifactParent);

    const result = await runReadiness(repositoryRoot, artifactRoot);

    expect(JSON.parse(result.stdout)).toEqual({
      schema: "intentarc.signed-release-artifact-parent-readiness/v1",
      status: "PASS",
      artifactParentReady: true,
    });
  });

  it.each([
    ["wrong argument order", ["-ArtifactRoot", "C:\\wrong", "-RepositoryRoot", "C:\\wrong"]],
    ["wrong switch", ["-Repository", "C:\\wrong", "-ArtifactRoot", "C:\\wrong"]],
    ["a common PowerShell parameter", ["-Verbose"]],
  ])("refuses %s without interpreting ambient script binding", async (_name, argumentsVector) => {
    // Break caught: a loose script-level parameter binding could accept a
    // caller-controlled vector outside the two reviewed paths.
    const failure = execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", readinessScriptPath, ...argumentsVector], {
      encoding: "utf8", env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR },
    });
    await expectRefusal(failure, "arguments-invalid");
  });

  it.each([
    ["relative repository root", "relative-repository", "arguments-invalid"],
    ["relative artifact root", "relative-artifact", "artifact-path-invalid"],
    ["wrong artifact leaf", "intentarc-phase1-signed-20260830-other", "artifact-path-invalid"],
    ["nested artifact leaf", `nested\\${artifactLeaf}`, "artifact-path-invalid"],
    ["sibling outside artifacts", `..\\sibling\\${artifactLeaf}`, "artifact-path-invalid"],
    ["a quote", `${artifactLeaf}'`, "artifact-path-invalid"],
    ["wildcard syntax", `${artifactLeaf}*`, "artifact-path-invalid"],
    ["a newline", `${artifactLeaf}\n`, "artifact-path-invalid"],
    ["a carriage return", `${artifactLeaf}\r`, "artifact-path-invalid"],
  ])("refuses %s as a bounded path error", async (_name, candidate, category) => {
    // Break caught: accepting a noncanonical path could prepare a parent other
    // than the reviewed run-03 destination.
    const { repositoryRoot, artifactRoot } = await createFixture();
    const suppliedRepository = _name === "relative repository root" ? candidate : repositoryRoot;
    const suppliedArtifact = _name === "relative artifact root" ? candidate : join(repositoryRoot, ".superpowers", "artifacts", candidate);
    const result = await runReadinessFunction([
      "'-RepositoryRoot'",
      `'${escapePowerShell(suppliedRepository)}'`,
      "'-ArtifactRoot'",
      `'${escapePowerShell(suppliedArtifact)}'`,
    ].join(", "));
    expect(JSON.parse(result.stdout)).toEqual({
      schema: "intentarc.signed-release-artifact-parent-readiness/v1", status: "REFUSED", category,
    });
    expect(await exists(artifactRoot)).toBe(false);
  });

  it.each([
    ["drive-relative", "C:relative"],
    ["root-relative", "\\relative"],
    ["incomplete UNC", "\\\\server"],
    ["drive-only", "C:"],
    ["extended-length device path", "\\\\?\\C:\\device-root"],
    ["Win32 device path", "\\\\.\\C:\\device-root"],
  ])("refuses a %s repository or artifact root before canonicalization", async (_name, malformedRoot) => {
    // Break caught: IsPathRooted accepts paths whose GetFullPath result depends
    // on the host drive/current-directory state rather than reviewed input.
    const { repositoryRoot, artifactRoot } = await createFixture();
    const repositoryResult = await runReadinessFunction([
      "'-RepositoryRoot'", `'${escapePowerShell(malformedRoot)}'`, "'-ArtifactRoot'", `'${escapePowerShell(artifactRoot)}'`,
    ].join(", "));
    const artifactResult = await runReadinessFunction([
      "'-RepositoryRoot'", `'${escapePowerShell(repositoryRoot)}'`, "'-ArtifactRoot'", `'${escapePowerShell(malformedRoot)}'`,
    ].join(", "));

    expect(JSON.parse(repositoryResult.stdout)).toEqual({
      schema: "intentarc.signed-release-artifact-parent-readiness/v1", status: "REFUSED", category: "arguments-invalid",
    });
    expect(JSON.parse(artifactResult.stdout)).toEqual({
      schema: "intentarc.signed-release-artifact-parent-readiness/v1", status: "REFUSED", category: "artifact-path-invalid",
    });
  });

  it("refuses a NUL-bearing artifact path through the dot-sourced raw-vector contract", async () => {
    // Break caught: an embedded NUL must not escape the closed argument parser
    // through a process transport normalization.
    const { repositoryRoot, artifactRoot } = await createFixture();
    const command = [
      `. '${escapePowerShell(readinessScriptPath)}'`,
      `$result = Initialize-IntentArcSignedReleaseArtifactParent -ArgumentsVector @('-RepositoryRoot', '${escapePowerShell(repositoryRoot)}', '-ArtifactRoot', ('${escapePowerShell(artifactRoot)}' + [char]0))`,
      "$result | ConvertTo-Json -Compress",
    ].join("\r\n");
    const result = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(command)], {
      encoding: "utf8", env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR },
    });
    expect(JSON.parse(result.stdout)).toEqual({
      schema: "intentarc.signed-release-artifact-parent-readiness/v1", status: "REFUSED", category: "artifact-path-invalid",
    });
  });

  it.each(["repository", "superpowers", "artifact-parent"])("refuses a %s file or reparse point", async (kind) => {
    // Break caught: following a file or reparse point permits parent creation
    // outside the repository's ordinary reviewed directory chain.
    const { root, repositoryRoot, artifactRoot, artifactParent } = await createFixture();
    let candidateRepository = repositoryRoot;
    if (kind === "repository") {
      await rm(repositoryRoot, { recursive: true, force: true });
      await writeFile(repositoryRoot, "not a directory", "utf8");
    } else if (kind === "superpowers") {
      await rm(join(repositoryRoot, ".superpowers"), { recursive: true, force: true });
      await writeFile(join(repositoryRoot, ".superpowers"), "not a directory", "utf8");
    } else {
      await writeFile(artifactParent, "not a directory", "utf8");
    }
    await expectRefusal(runReadiness(candidateRepository, artifactRoot), kind === "artifact-parent" ? "artifact-parent-invalid" : "repository-invalid");

    const target = join(root, `${kind}-target`);
    if (kind === "repository") {
      await rm(repositoryRoot, { force: true });
      await mkdir(target);
      await symlink(target, repositoryRoot, "junction");
    } else if (kind === "superpowers") {
      await rm(join(repositoryRoot, ".superpowers"), { force: true });
      await mkdir(target);
      await symlink(target, join(repositoryRoot, ".superpowers"), "junction");
    } else {
      await rm(artifactParent, { force: true });
      await mkdir(target);
      await symlink(target, artifactParent, "junction");
    }
    await expectRefusal(runReadiness(candidateRepository, artifactRoot), kind === "artifact-parent" ? "artifact-parent-invalid" : "repository-invalid");
  });

  it.each(["final file", "final directory", "staging file", "staging directory"])("refuses existing %s as used run state", async (kind) => {
    // Break caught: accepting either final or staging state can overwrite or
    // merge a previously attempted run.
    const { repositoryRoot, artifactRoot, artifactParent } = await createFixture();
    await mkdir(artifactParent);
    const target = kind.startsWith("staging") ? `${artifactRoot}.staging` : artifactRoot;
    if (kind.endsWith("file")) await writeFile(target, "used", "utf8");
    else await mkdir(target);

    await expectRefusal(runReadiness(repositoryRoot, artifactRoot), "artifact-run-state-used");
  });

  it.each(["final", "staging"])("refuses a dangling %s reparse entry as used run state", async (kind) => {
    // Break caught: File.Exists/Directory.Exists both report false for a
    // dangling link, allowing an occupied exact run path to pass as absent.
    const { root, repositoryRoot, artifactRoot, artifactParent } = await createFixture();
    await mkdir(artifactParent);
    const target = kind === "final" ? artifactRoot : `${artifactRoot}.staging`;
    const missingTarget = join(root, "missing-target");
    await mkdir(missingTarget);
    await symlink(missingTarget, target, "junction");
    await rm(missingTarget, { recursive: true, force: true });

    await expectRefusal(runReadiness(repositoryRoot, artifactRoot), "artifact-run-state-used");
  });

  it("refuses closed when an exact final-state probe is indeterminate", async () => {
    // Break caught: treating an access or IO error as absence allows an
    // unobserved exact entry to be mistaken for fresh run state.
    const { repositoryRoot, artifactRoot, artifactParent } = await createFixture();
    await mkdir(artifactParent);
    const command = [
      "$ProgressPreference = 'SilentlyContinue'",
      `$artifact = '${escapePowerShell(artifactRoot)}'`,
      "function global:Get-Item { param($LiteralPath, [switch]$Force, $ErrorAction); if ([string]::Equals($LiteralPath, $artifact, [StringComparison]::OrdinalIgnoreCase)) { throw [UnauthorizedAccessException]::new('probe denied') }; Microsoft.PowerShell.Management\\Get-Item -LiteralPath $LiteralPath -Force:$Force -ErrorAction $ErrorAction }",
      `. '${escapePowerShell(readinessScriptPath)}'`,
      `$result = Initialize-IntentArcSignedReleaseArtifactParent -ArgumentsVector @('-RepositoryRoot', '${escapePowerShell(repositoryRoot)}', '-ArtifactRoot', $artifact)`,
      "$result | ConvertTo-Json -Compress",
    ].join("\r\n");
    const result = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(command)], {
      encoding: "utf8", env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR },
    });

    expect(JSON.parse(result.stdout)).toEqual({
      schema: "intentarc.signed-release-artifact-parent-readiness/v1", status: "REFUSED", category: "artifact-parent-invalid",
    });
  });

  it("refuses boundary drift after final-state probing", async () => {
    // Break caught: accepting a parent after its .superpowers boundary changes
    // during exact-state probes permits a controlled-host path swap.
    const { root, repositoryRoot, artifactRoot } = await createFixture();
    const superpowers = join(repositoryRoot, ".superpowers");
    const replacement = join(root, "replacement-superpowers");
    await mkdir(replacement);
    const command = [
      "$ProgressPreference = 'SilentlyContinue'",
      `$superpowers = '${escapePowerShell(superpowers)}'`,
      `$replacement = '${escapePowerShell(replacement)}'`,
      `$artifact = '${escapePowerShell(artifactRoot)}'`,
      "function global:Get-Item { param($LiteralPath, [switch]$Force, $ErrorAction); if ([string]::Equals($LiteralPath, $artifact, [StringComparison]::OrdinalIgnoreCase)) { [IO.Directory]::Delete($superpowers, $true); New-Item -ItemType Junction -Path $superpowers -Target $replacement -ErrorAction Stop | Out-Null }; Microsoft.PowerShell.Management\\Get-Item -LiteralPath $LiteralPath -Force:$Force -ErrorAction $ErrorAction }",
      `. '${escapePowerShell(readinessScriptPath)}'`,
      `$result = Initialize-IntentArcSignedReleaseArtifactParent -ArgumentsVector @('-RepositoryRoot', '${escapePowerShell(repositoryRoot)}', '-ArtifactRoot', $artifact)`,
      "$result | ConvertTo-Json -Compress",
    ].join("\r\n");
    const result = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(command)], {
      encoding: "utf8", env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR },
    });

    expect(JSON.parse(result.stdout)).toEqual({
      schema: "intentarc.signed-release-artifact-parent-readiness/v1", status: "REFUSED", category: "repository-invalid",
    });
  });

  it("rechecks boundaries before creation so a swapped parent receives no artifacts directory", async () => {
    // Break caught: omitting the pre-create recheck allows a .superpowers swap
    // to redirect the sole approved creation into an uncontrolled target.
    const { root, repositoryRoot, artifactRoot } = await createFixture();
    const superpowers = join(repositoryRoot, ".superpowers");
    const replacement = join(root, "replacement-before-create");
    await mkdir(replacement);
    const command = [
      "$ProgressPreference = 'SilentlyContinue'",
      "$script:repositoryLookups = 0",
      `$repository = '${escapePowerShell(repositoryRoot)}'`,
      `$superpowers = '${escapePowerShell(superpowers)}'`,
      `$replacement = '${escapePowerShell(replacement)}'`,
      `$artifact = '${escapePowerShell(artifactRoot)}'`,
      "function global:Get-Item { param($LiteralPath, [switch]$Force, $ErrorAction); if ([string]::Equals($LiteralPath, $repository, [StringComparison]::OrdinalIgnoreCase)) { $script:repositoryLookups++; if ($script:repositoryLookups -eq 2) { [IO.Directory]::Delete($superpowers, $true); New-Item -ItemType Junction -Path $superpowers -Target $replacement -ErrorAction Stop | Out-Null } }; Microsoft.PowerShell.Management\\Get-Item -LiteralPath $LiteralPath -Force:$Force -ErrorAction $ErrorAction }",
      `. '${escapePowerShell(readinessScriptPath)}'`,
      `$result = Initialize-IntentArcSignedReleaseArtifactParent -ArgumentsVector @('-RepositoryRoot', $repository, '-ArtifactRoot', $artifact)`,
      `[ordered]@{ result = $result; redirectedArtifactsExists = [IO.Directory]::Exists((Join-Path $replacement 'artifacts')) } | ConvertTo-Json -Depth 4 -Compress`,
    ].join("\r\n");
    const result = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(command)], {
      encoding: "utf8", env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR },
    });

    expect(JSON.parse(result.stdout)).toEqual({
      result: {
        schema: "intentarc.signed-release-artifact-parent-readiness/v1", status: "REFUSED", category: "repository-invalid",
      },
      redirectedArtifactsExists: false,
    });
  });

  it("revalidates boundaries immediately after deciding the parent is absent before creating it", async () => {
    // Break caught: a boundary check before the File.Exists/Directory.Exists
    // decision leaves a swap interval immediately before CreateDirectory.
    const source = await readFile(readinessScriptPath, "utf8");
    const fileDecision = source.indexOf("$parentFileExists = [IO.File]::Exists($expectedParent)");
    const directoryDecision = source.indexOf("$parentDirectoryExists = [IO.Directory]::Exists($expectedParent)");
    const revalidation = source.indexOf("if (-not (& $identityMatches $repositoryIdentity $canonicalRepository) -or", directoryDecision);
    const creation = source.indexOf("[void][IO.Directory]::CreateDirectory($expectedParent)");
    expect(fileDecision).toBeGreaterThanOrEqual(0);
    expect(directoryDecision).toBeGreaterThan(fileDecision);
    expect(revalidation).toBeGreaterThan(directoryDecision);
    expect(creation).toBeGreaterThan(revalidation);

    const { root, repositoryRoot, artifactRoot } = await createFixture();
    const superpowers = join(repositoryRoot, ".superpowers");
    const replacement = join(root, "replacement-after-parent-decision");
    await mkdir(replacement);
    const command = [
      "$ProgressPreference = 'SilentlyContinue'",
      "$script:repositoryLookups = 0",
      `$repository = '${escapePowerShell(repositoryRoot)}'`,
      `$superpowers = '${escapePowerShell(superpowers)}'`,
      `$replacement = '${escapePowerShell(replacement)}'`,
      `$artifact = '${escapePowerShell(artifactRoot)}'`,
      "function global:Get-Item { param($LiteralPath, [switch]$Force, $ErrorAction); if ([string]::Equals($LiteralPath, $repository, [StringComparison]::OrdinalIgnoreCase)) { $script:repositoryLookups++; if ($script:repositoryLookups -eq 2) { [IO.Directory]::Delete($superpowers, $true); New-Item -ItemType Junction -Path $superpowers -Target $replacement -ErrorAction Stop | Out-Null } }; Microsoft.PowerShell.Management\\Get-Item -LiteralPath $LiteralPath -Force:$Force -ErrorAction $ErrorAction }",
      `. '${escapePowerShell(readinessScriptPath)}'`,
      `$result = Initialize-IntentArcSignedReleaseArtifactParent -ArgumentsVector @('-RepositoryRoot', $repository, '-ArtifactRoot', $artifact)`,
      `[ordered]@{ result = $result; redirectedArtifactsExists = [IO.Directory]::Exists((Join-Path $replacement 'artifacts')) } | ConvertTo-Json -Depth 4 -Compress`,
    ].join("\r\n");
    const result = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(command)], {
      encoding: "utf8", env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR },
    });

    expect(JSON.parse(result.stdout)).toEqual({
      result: {
        schema: "intentarc.signed-release-artifact-parent-readiness/v1", status: "REFUSED", category: "repository-invalid",
      },
      redirectedArtifactsExists: false,
    });
  });

  it("refuses boundary drift immediately after artifact-parent creation", async () => {
    // Break caught: omitting the post-create recheck accepts a parent created
    // beneath a .superpowers boundary that changes before probing run state.
    const { root, repositoryRoot, artifactRoot } = await createFixture();
    const superpowers = join(repositoryRoot, ".superpowers");
    const replacement = join(root, "replacement-after-create");
    await mkdir(replacement);
    const command = [
      "$ProgressPreference = 'SilentlyContinue'",
      "$script:repositoryLookups = 0",
      `$repository = '${escapePowerShell(repositoryRoot)}'`,
      `$superpowers = '${escapePowerShell(superpowers)}'`,
      `$replacement = '${escapePowerShell(replacement)}'`,
      `$artifact = '${escapePowerShell(artifactRoot)}'`,
      "function global:Get-Item { param($LiteralPath, [switch]$Force, $ErrorAction); if ([string]::Equals($LiteralPath, $repository, [StringComparison]::OrdinalIgnoreCase)) { $script:repositoryLookups++; if ($script:repositoryLookups -eq 3) { [IO.Directory]::Delete($superpowers, $true); New-Item -ItemType Junction -Path $superpowers -Target $replacement -ErrorAction Stop | Out-Null } }; Microsoft.PowerShell.Management\\Get-Item -LiteralPath $LiteralPath -Force:$Force -ErrorAction $ErrorAction }",
      `. '${escapePowerShell(readinessScriptPath)}'`,
      `$result = Initialize-IntentArcSignedReleaseArtifactParent -ArgumentsVector @('-RepositoryRoot', $repository, '-ArtifactRoot', $artifact)`,
      `[ordered]@{ result = $result; redirectedArtifactsExists = [IO.Directory]::Exists((Join-Path $replacement 'artifacts')) } | ConvertTo-Json -Depth 4 -Compress`,
    ].join("\r\n");
    const result = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(command)], {
      encoding: "utf8", env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR },
    });

    expect(JSON.parse(result.stdout)).toEqual({
      result: {
        schema: "intentarc.signed-release-artifact-parent-readiness/v1", status: "REFUSED", category: "repository-invalid",
      },
      redirectedArtifactsExists: false,
    });
  });

  it("refuses artifact-parent drift after final and staging probes", async () => {
    // Break caught: accepting the original parent identity after exact-state
    // probes allows the final readiness result to bless a swapped parent.
    const { root, repositoryRoot, artifactRoot, artifactParent } = await createFixture();
    await mkdir(artifactParent);
    const replacement = join(root, "replacement-artifact-parent");
    await mkdir(replacement);
    const staging = `${artifactRoot}.staging`;
    const command = [
      "$ProgressPreference = 'SilentlyContinue'",
      `$artifactParent = '${escapePowerShell(artifactParent)}'`,
      `$replacement = '${escapePowerShell(replacement)}'`,
      `$repository = '${escapePowerShell(repositoryRoot)}'`,
      `$artifact = '${escapePowerShell(artifactRoot)}'`,
      `$staging = '${escapePowerShell(staging)}'`,
      "function global:Get-Item { param($LiteralPath, [switch]$Force, $ErrorAction); if ([string]::Equals($LiteralPath, $staging, [StringComparison]::OrdinalIgnoreCase)) { [IO.Directory]::Delete($artifactParent, $true); New-Item -ItemType Junction -Path $artifactParent -Target $replacement -ErrorAction Stop | Out-Null }; Microsoft.PowerShell.Management\\Get-Item -LiteralPath $LiteralPath -Force:$Force -ErrorAction $ErrorAction }",
      `. '${escapePowerShell(readinessScriptPath)}'`,
      `$result = Initialize-IntentArcSignedReleaseArtifactParent -ArgumentsVector @('-RepositoryRoot', $repository, '-ArtifactRoot', $artifact)`,
      "$result | ConvertTo-Json -Compress",
    ].join("\r\n");
    const result = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(command)], {
      encoding: "utf8", env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR },
    });

    expect(JSON.parse(result.stdout)).toEqual({
      schema: "intentarc.signed-release-artifact-parent-readiness/v1", status: "REFUSED", category: "artifact-parent-invalid",
    });
  });

  it("leaves an existing unrelated parent sentinel byte-identical", async () => {
    // Break caught: enumerating or rewriting the existing parent would touch
    // unrelated evidence while only readiness was requested.
    const { repositoryRoot, artifactRoot, artifactParent } = await createFixture();
    await mkdir(artifactParent);
    const sentinel = join(artifactParent, "unrelated-sentinel.bin");
    const bytes = Buffer.from([0, 255, 17, 0, 42]);
    await writeFile(sentinel, bytes);

    await runReadiness(repositoryRoot, artifactRoot);

    expect(await lstat(sentinel)).toMatchObject({ size: bytes.length });
    expect(await import("node:fs/promises").then(({ readFile }) => readFile(sentinel))).toEqual(bytes);
  });

  it("is dormant when dot-sourced after mutation-command traps are installed", async () => {
    // Break caught: import-time creation would mutate before the explicit
    // readiness invocation and bypass the caller's reviewed arguments.
    const command = [
      "$ProgressPreference = 'SilentlyContinue'",
      "$script:mutations = 0",
      "function global:New-Item { $script:mutations++; throw 'mutation-trap' }",
      "function global:Remove-Item { $script:mutations++; throw 'mutation-trap' }",
      "function global:Start-Process { $script:mutations++; throw 'mutation-trap' }",
      `. '${escapePowerShell(readinessScriptPath)}'`,
      "[ordered]@{ mutations = $script:mutations; available = $null -ne (Get-Command Initialize-IntentArcSignedReleaseArtifactParent -CommandType Function) } | ConvertTo-Json -Compress",
    ].join("\r\n");
    const result = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(command)], {
      encoding: "utf8", env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR },
    });
    expect(JSON.parse(result.stdout)).toEqual({ mutations: 0, available: true });
    expect(result.stderr).toBe("");
  });
});
