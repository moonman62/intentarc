import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = join(process.cwd(), "scripts", "windows-signing-certificate.ps1");
const windowsOnly = process.platform === "win32" ? describe : describe.skip;

const runPowerShell = async (args: string[]) => execFileAsync(
  "powershell.exe",
  ["-NoProfile", "-NonInteractive", ...args],
  {
    encoding: "utf8",
    env: {
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR,
    },
    maxBuffer: 1024,
    timeout: 30_000,
    windowsHide: true,
  },
);

const encodePowerShell = (source: string) =>
  Buffer.from(source, "utf16le").toString("base64");

const publicCertificateDer =
  "MIICfzCCAegCCQDxxeXw914Y2DANBgkqhkiG9w0BAQsFADCBgzELMAkGA1UEBhMCSU4xEzARBgNVBAgMCldlc3RiZW5nYWwxEDAOBgNVBAcMB0tvbGthdGExFDASBgNVBAoMC1BhbmNvLCBJbmMuMRUwEwYDVQQDDAxSb2hpdCBQcmFzYWQxIDAeBgkqhkiG9w0BCQEWEXJvZm9mb2ZAZ21haWwuY29tMB4XDTIwMDkwOTA1NTExN1oXDTIwMTAwOTA1NTExN1owgYMxCzAJBgNVBAYTAklOMRMwEQYDVQQIDApXZXN0YmVuZ2FsMRAwDgYDVQQHDAdLb2xrYXRhMRQwEgYDVQQKDAtQYW5jbywgSW5jLjEVMBMGA1UEAwwMUm9oaXQgUHJhc2FkMSAwHgYJKoZIhvcNAQkBFhFyb2ZvZm9mQGdtYWlsLmNvbTCBnzANBgkqhkiG9w0BAQEFAAOBjQAwgYkCgYEAt/EfcF3FG4TneOBWr4JhOUdyuCXmDhy5yO3VKtQfPxr+5d0joCSnn/5vYDNSr1MfedZmqVxrXFoMAdPCd71BNmDmeLViQK61WREtASP0ZhQMoUBT+R3Fpdy0jPS0YoT/fBd96CJCmgsQOS8Tq5IKVeB61MyCkwAQ2Goe0T3sdVkCAwEAATANBgkqhkiG9w0BAQsFAAOBgQATe6ixdAjoV7BSHgRXbXM2+IZLq8kq3s7ck0EZrRVhsivutcaZwDXRCCinB+OlPedbzXwNZGvVX0nwPYHGBfiXwdiuZeVJ88ni6Fm6RhoPtu2QF1UExfBvSXuMBgR+evp+e3QadNpGx6Ppl1aChWF6W2H9+MAlU7yvtmCQQuZmfQ==";

windowsOnly("Windows signing certificate compatibility", () => {
  it("reports PowerShell 5.1 static-extension compatibility with zero mutations", async () => {
    const result = await runPowerShell(["-File", scriptPath, "-StaticSelfTest"]);

    expect(result.stderr).toBe("");
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(128);
    expect(result.stdout).toBe(
      '{"instanceMethod":false,"staticExtension":true,"mutations":0}\r\n',
    );
  });

  it("uses the static RSA extension and excludes certificate import or removal", async () => {
    const source = await readFile(scriptPath, "utf8");

    expect(source).toContain(
      "[Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($Certificate)",
    );
    expect(source).not.toMatch(/Remove-Item|Import-Certificate|Import-PfxCertificate/i);
  });

  it("has no case-insensitive instance RSA call in the PowerShell AST", async () => {
    const escapedPath = scriptPath.replaceAll("'", "''");
    const command = [
      "$tokens = $null",
      "$parseErrors = $null",
      `$ast = [Management.Automation.Language.Parser]::ParseFile('${escapedPath}', [ref]$tokens, [ref]$parseErrors)`,
      "if ($parseErrors.Count -ne 0) { throw 'script parse failed' }",
      "$matches = @($ast.FindAll({",
      "  param($node)",
      "  $node -is [Management.Automation.Language.InvokeMemberExpressionAst] -and",
      "    $node.Expression -is [Management.Automation.Language.VariableExpressionAst] -and",
      "    $node.Expression.VariablePath.UserPath -ieq 'certificate' -and",
      "    $node.Member.Value -ieq 'GetRSAPrivateKey'",
      "}, $true))",
      "[Console]::Out.WriteLine(('instanceCalls:' + $matches.Count))",
    ].join("\r\n");
    const result = await runPowerShell(["-EncodedCommand", encodePowerShell(command)]);

    expect(result.stdout).toBe("instanceCalls:0\r\n");
    expect(result.stderr).toBe("");
  });

  it("opens an in-memory public certificate through the PowerShell 5.1-compatible helper", async () => {
    const escapedPath = scriptPath.replaceAll("'", "''");
    const command = [
      `. '${escapedPath}'`,
      "$ProgressPreference = 'SilentlyContinue'",
      `$bytes = [Convert]::FromBase64String('${publicCertificateDer}')`,
      "$certificate = New-Object Security.Cryptography.X509Certificates.X509Certificate2 -ArgumentList @(,$bytes)",
      "try {",
      "  $rsa = Get-IntentArcRsaPrivateKey -Certificate $certificate",
      "  try { [Console]::Out.WriteLine(('privateKey:' + ($null -ne $rsa).ToString().ToLowerInvariant())) } finally { if ($null -ne $rsa) { $rsa.Dispose() } }",
      "} finally { $certificate.Dispose() }",
    ].join("\r\n");
    const result = await runPowerShell(["-EncodedCommand", encodePowerShell(command)]);

    expect(result.stdout).toBe("privateKey:false\r\n");
    expect(result.stderr).toBe("");
  });

  it("executes the dormant default private-key opener through the static helper", async () => {
    const escapedPath = scriptPath.replaceAll("'", "''");
    const command = [
      `. '${escapedPath}'`,
      "$ProgressPreference = 'SilentlyContinue'",
      `$bytes = [Convert]::FromBase64String('${publicCertificateDer}')`,
      "$certificate = New-Object Security.Cryptography.X509Certificates.X509Certificate2 -ArgumentList @(,$bytes)",
      "$commands = Get-IntentArcSigningCertificateCommands",
      "try {",
      "  [void](& $commands['private-key-open'] $certificate)",
      "  [Console]::Out.WriteLine('unexpected-success')",
      "} catch { [Console]::Out.WriteLine($_.Exception.Message) } finally { $certificate.Dispose() }",
    ].join("\r\n");
    const result = await runPowerShell(["-EncodedCommand", encodePowerShell(command)]);

    expect(result.stdout).toBe("private key unavailable\r\n");
    expect(result.stderr).toBe("");
  });

  it("performs no operation when dot-sourced", async () => {
    const escapedPath = scriptPath.replaceAll("'", "''");
    const result = await runPowerShell(["-Command", `. '${escapedPath}'`]);

    expect(result).toEqual(expect.objectContaining({ stdout: "", stderr: "" }));
  });

  it("provides five dormant mutation commands as a PowerShell hashtable", async () => {
    const escapedPath = scriptPath.replaceAll("'", "''");
    const command = [
      `. '${escapedPath}'`,
      "$commands = Get-IntentArcSigningCertificateCommands",
      "[Console]::Out.WriteLine(('type:' + $commands.GetType().FullName + ';count:' + $commands.Count))",
    ].join("\r\n");
    const result = await runPowerShell(["-EncodedCommand", encodePowerShell(command)]);

    expect(result.stdout).toBe("type:System.Collections.Hashtable;count:5\r\n");
    expect(result.stderr).toBe("");
  });

  it.each([
    "certificate-create",
    "private-key-open",
    "certificate-export",
    "public-certificate-export",
    "thumbprint-verify",
  ])("reports only the stable %s stage when an injected operation fails", async (stage) => {
    const escapedPath = scriptPath.replaceAll("'", "''");
    const command = [
      `. '${escapedPath}'`,
      "$ProgressPreference = 'SilentlyContinue'",
      `$failedStage = '${stage}'`,
      "$fakeCertificate = [pscustomobject]@{ Thumbprint = ('A' * 40) }",
      "$commands = @{}",
      "foreach ($name in @('certificate-create','private-key-open','certificate-export','public-certificate-export','thumbprint-verify')) {",
      "  $capturedName = $name",
      "  $commands[$name] = { param($Arguments) if ($failedStage -ceq $capturedName) { throw 'raw secret path and password' }; if ($capturedName -ceq 'certificate-create') { return $fakeCertificate }; return $true }.GetNewClosure()",
      "}",
      "try {",
      "  $password = [Activator]::CreateInstance([Security.SecureString])",
      "  [void](New-IntentArcSigningCertificate -Subject 'CN=Static Test' -CertStoreLocation 'Cert:\\CurrentUser\\My' -KeyContainerName 'IntentArc.Release.Static-Test' -PfxPath 'unused-private.pfx' -PublicCertificatePath 'unused-public.cer' -Password $password -Commands $commands)",
      "  [Console]::Out.WriteLine('unexpected-success')",
      "} catch { [Console]::Out.WriteLine($_.Exception.Message) }",
    ].join("\r\n");

    const result = await runPowerShell(["-EncodedCommand", encodePowerShell(command)]);

    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      `IntentArc signing certificate preparation failed: ${stage}.\r\n`,
    );
    expect(result.stdout).not.toContain("raw secret");
    expect(result.stdout).not.toContain("unused-");
  });

  it.each([
    "certificate-create",
    "private-key-open",
    "certificate-export",
    "public-certificate-export",
    "thumbprint-verify",
  ])("terminates and bounds a non-terminating error from %s", async (stage) => {
    const escapedPath = scriptPath.replaceAll("'", "''");
    const command = [
      `. '${escapedPath}'`,
      "$ProgressPreference = 'SilentlyContinue'",
      `$failedStage = '${stage}'`,
      "$continuationCounter = [pscustomobject]@{ Value = 0 }",
      "$fakeCertificate = [pscustomobject]@{ Thumbprint = ('A' * 40) }",
      "$commands = @{}",
      "foreach ($name in @('certificate-create','private-key-open','certificate-export','public-certificate-export','thumbprint-verify')) {",
      "  $capturedName = $name",
      "  $commands[$name] = { param($Arguments) if ($failedStage -ceq $capturedName) { Write-Error 'raw secret path'; $continuationCounter.Value++; return $true }; if ($capturedName -ceq 'certificate-create') { return $fakeCertificate }; return $true }.GetNewClosure()",
      "}",
      "try {",
      "  $password = [Activator]::CreateInstance([Security.SecureString])",
      "  [void](New-IntentArcSigningCertificate -Subject 'CN=Static Test' -CertStoreLocation 'Cert:\\CurrentUser\\My' -KeyContainerName 'IntentArc.Release.Static-Test' -PfxPath 'unused-private.pfx' -PublicCertificatePath 'unused-public.cer' -Password $password -Commands $commands)",
      "  [Console]::Out.WriteLine('unexpected-success')",
      "} catch {",
      "  if ($continuationCounter.Value -ne 0) { [Console]::Out.WriteLine('unexpected-mutation') } elseif ($ErrorActionPreference -cne 'Continue') { [Console]::Out.WriteLine('unexpected-preference') } else { [Console]::Out.WriteLine($_.Exception.Message) }",
      "}",
    ].join("\r\n");
    const result = await runPowerShell(["-EncodedCommand", encodePowerShell(command)]);

    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      `IntentArc signing certificate preparation failed: ${stage}.\r\n`,
    );
    expect(result.stdout).not.toContain("raw secret");
    expect(result.stdout).not.toContain("unused-");
  });

  it("binds the exact CNG key container before certificate creation", async () => {
    // Break caught: discovering the key name only after private-key open leaves
    // cleanup without an identity when creation mutates and then throws.
    const escapedPath = scriptPath.replaceAll("'", "''");
    const command = [
      `. '${escapedPath}'`,
      "$ProgressPreference = 'SilentlyContinue'",
      "$seen = [pscustomobject]@{ Value = '' }",
      "$commands = @{",
      "  'certificate-create' = { param($Subject, $Store, $KeyContainerName); $seen.Value = $KeyContainerName; [pscustomobject]@{ Thumbprint = ('A' * 40) } }.GetNewClosure()",
      "  'private-key-open' = { param($Certificate); $true }",
      "  'certificate-export' = { param($Certificate, $Path, $Password); $true }",
      "  'public-certificate-export' = { param($Certificate, $Path); $true }",
      "  'thumbprint-verify' = { param($Certificate, $Path); $true }",
      "}",
      "$password = [Activator]::CreateInstance([Security.SecureString])",
      "[void](New-IntentArcSigningCertificate -Subject 'CN=Static Test' -CertStoreLocation 'Cert:\\CurrentUser\\My' -KeyContainerName 'IntentArc.Release.Static-Test' -PfxPath 'unused-private.pfx' -PublicCertificatePath 'unused-public.cer' -Password $password -Commands $commands)",
      "$cmdlet = Get-Command New-SelfSignedCertificate -ErrorAction Stop",
      "$defaultCreate = [string](Get-IntentArcSigningCertificateCommands)['certificate-create']",
      "[ordered]@{ seen = $seen.Value; cmdletHasContainer = $cmdlet.Parameters.ContainsKey('Container'); cmdletHasKeyContainer = $cmdlet.Parameters.ContainsKey('KeyContainer'); defaultContainsContainer = $defaultCreate.Contains('-Container $KeyContainerName'); defaultPublishesIdentity = ($defaultCreate.Contains('$CreationState.certificate = $createdCertificate') -and $defaultCreate.Contains('$CreationState.thumbprint = $createdCertificate.Thumbprint')) } | ConvertTo-Json -Compress",
    ].join("\r\n");
    const result = await runPowerShell(["-EncodedCommand", encodePowerShell(command)]);

    expect(JSON.parse(result.stdout.trim())).toEqual({
      seen: "IntentArc.Release.Static-Test",
      cmdletHasContainer: true,
      cmdletHasKeyContainer: false,
      defaultContainsContainer: true,
      defaultPublishesIdentity: true,
    });
  });
});
