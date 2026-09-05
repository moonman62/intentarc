import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveWindowsPowerShellInvocation } from "../src/system/windows-powershell.js";

const executeFile = promisify(execFile);

const runAuthenticodePowerShell = async (targetPath, mode) => {
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "$target = [Environment]::GetEnvironmentVariable('INTENTARC_SIGNATURE_TARGET', 'Process')",
    "$signature = Get-AuthenticodeSignature -LiteralPath $target",
    "[Console]::Out.WriteLine($signature.Status.ToString())",
    mode === "publisher"
      ? "if ($signature.Status -eq [System.Management.Automation.SignatureStatus]::Valid -and $null -ne $signature.SignerCertificate) { [Console]::Out.WriteLine($signature.SignerCertificate.Thumbprint); [Console]::Out.WriteLine($signature.SignerCertificate.Subject) }"
      : "",
  ].filter(Boolean).join("; ");
  const powerShell = resolveWindowsPowerShellInvocation(process.env);
  let stdout;
  try {
    ({ stdout } = await executeFile(powerShell.executablePath, [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      command,
    ], {
      env: {
        SystemRoot: powerShell.environment.SystemRoot,
        WINDIR: powerShell.environment.WINDIR,
        INTENTARC_SIGNATURE_TARGET: targetPath,
      },
      windowsHide: true,
      maxBuffer: 64 * 1024,
    }));
  } catch {
    throw new Error(
      "IntentArc Authenticode verification could not verify a valid executable.",
    );
  }
  const [status, thumbprint, ...subject] = stdout.trim().split(/\r?\n/);
  return {
    status: status ?? "UnknownError",
    thumbprint: thumbprint ?? "",
    subject: subject.join("\n"),
  };
};

export const verifyAuthenticodeSignature = async (targetPath) => {
  const result = await runAuthenticodePowerShell(targetPath, "verify");
  if (result.status !== "Valid") {
    throw new Error(`Invalid Authenticode signature: ${result.status}.`);
  }
};

export const readAuthenticodePublisher = async (targetPath) => {
  const result = await runAuthenticodePowerShell(targetPath, "publisher");
  if (!/^[A-Fa-f0-9]{40}$/.test(result.thumbprint) || !result.subject) {
    throw new Error("IntentArc release publisher identity is malformed.");
  }
  return { thumbprint: result.thumbprint, subject: result.subject };
};
