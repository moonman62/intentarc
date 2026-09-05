function Get-IntentArcWindowsCommandLineProbe {
    param([object[]] $ArgumentsVector = @())
    if ($ArgumentsVector.Count -ne 0) { throw 'commandline-probe-invalid' }
    $encoding = [Text.UTF8Encoding]::new($false, $true)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = $encoding.GetBytes([Environment]::CommandLine)
        $sha256 = ([BitConverter]::ToString($algorithm.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
        return [ordered]@{
            schema = 'intentarc.windows-commandline-probe/v1'
            commandLineSha256 = $sha256
        }
    } finally {
        $algorithm.Dispose()
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        Get-IntentArcWindowsCommandLineProbe -ArgumentsVector @($args) | ConvertTo-Json -Compress
    } catch {
        [Console]::Error.Write("commandline-probe-invalid`n")
        exit 1
    }
}
