Set-StrictMode -Version Latest

function Throw-IntentArcAuthorizationManifestInvalid {
    throw 'authorization-manifest-invalid'
}

function Get-IntentArcSha256ForBytes {
    param([Parameter(Mandatory)][byte[]] $Bytes)

    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($algorithm.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant()
    } finally {
        $algorithm.Dispose()
    }
}

function Get-IntentArcAuthorizationManifestHash {
    param([Parameter(Mandatory)][string] $LiteralPath)

    try {
        return Get-IntentArcSha256ForBytes -Bytes ([IO.File]::ReadAllBytes($LiteralPath))
    } catch {
        throw 'authorization-manifest-digest'
    }
}

function Assert-IntentArcJsonHasNoDuplicateKeys {
    param([Parameter(Mandatory)][string] $Text)

    $state = [pscustomobject]@{ Position = 0; Length = $Text.Length }

    function Skip-IntentArcJsonWhitespace {
        while ($state.Position -lt $state.Length -and [char]::IsWhiteSpace($Text[$state.Position])) {
            $state.Position += 1
        }
    }

    function Read-IntentArcJsonString {
        if ($state.Position -ge $state.Length -or $Text[$state.Position] -cne '"') {
            Throw-IntentArcAuthorizationManifestInvalid
        }
        $state.Position += 1
        $builder = New-Object Text.StringBuilder
        while ($state.Position -lt $state.Length) {
            $character = $Text[$state.Position]
            $state.Position += 1
            if ($character -ceq '"') {
                return $builder.ToString()
            }
            if ([int][char]$character -lt 32) {
                Throw-IntentArcAuthorizationManifestInvalid
            }
            if ($character -cne '\') {
                [void]$builder.Append($character)
                continue
            }
            if ($state.Position -ge $state.Length) {
                Throw-IntentArcAuthorizationManifestInvalid
            }
            $escape = [string]$Text[$state.Position]
            $state.Position += 1
            switch ($escape) {
                '"' { [void]$builder.Append('"'); break }
                '\' { [void]$builder.Append('\'); break }
                '/' { [void]$builder.Append('/'); break }
                'b' { [void]$builder.Append([char]8); break }
                'f' { [void]$builder.Append([char]12); break }
                'n' { [void]$builder.Append([char]10); break }
                'r' { [void]$builder.Append([char]13); break }
                't' { [void]$builder.Append([char]9); break }
                'u' {
                    if ($state.Position + 4 -gt $state.Length) {
                        Throw-IntentArcAuthorizationManifestInvalid
                    }
                    $hex = $Text.Substring($state.Position, 4)
                    if ($hex -notmatch '^[0-9a-fA-F]{4}$') {
                        Throw-IntentArcAuthorizationManifestInvalid
                    }
                    [void]$builder.Append([char][Convert]::ToInt32($hex, 16))
                    $state.Position += 4
                    break
                }
                default { Throw-IntentArcAuthorizationManifestInvalid }
            }
        }
        Throw-IntentArcAuthorizationManifestInvalid
    }

    function Read-IntentArcJsonValue {
        Skip-IntentArcJsonWhitespace
        if ($state.Position -ge $state.Length) {
            Throw-IntentArcAuthorizationManifestInvalid
        }
        $character = $Text[$state.Position]
        if ($character -ceq '{') {
            $state.Position += 1
            Skip-IntentArcJsonWhitespace
            $keys = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
            if ($state.Position -lt $state.Length -and $Text[$state.Position] -ceq '}') {
                $state.Position += 1
                return
            }
            while ($true) {
                Skip-IntentArcJsonWhitespace
                $key = Read-IntentArcJsonString
                if (-not $keys.Add($key)) {
                    Throw-IntentArcAuthorizationManifestInvalid
                }
                Skip-IntentArcJsonWhitespace
                if ($state.Position -ge $state.Length -or $Text[$state.Position] -cne ':') {
                    Throw-IntentArcAuthorizationManifestInvalid
                }
                $state.Position += 1
                Read-IntentArcJsonValue
                Skip-IntentArcJsonWhitespace
                if ($state.Position -ge $state.Length) {
                    Throw-IntentArcAuthorizationManifestInvalid
                }
                if ($Text[$state.Position] -ceq '}') {
                    $state.Position += 1
                    return
                }
                if ($Text[$state.Position] -cne ',') {
                    Throw-IntentArcAuthorizationManifestInvalid
                }
                $state.Position += 1
            }
        }
        if ($character -ceq '[') {
            $state.Position += 1
            Skip-IntentArcJsonWhitespace
            if ($state.Position -lt $state.Length -and $Text[$state.Position] -ceq ']') {
                $state.Position += 1
                return
            }
            while ($true) {
                Read-IntentArcJsonValue
                Skip-IntentArcJsonWhitespace
                if ($state.Position -ge $state.Length) {
                    Throw-IntentArcAuthorizationManifestInvalid
                }
                if ($Text[$state.Position] -ceq ']') {
                    $state.Position += 1
                    return
                }
                if ($Text[$state.Position] -cne ',') {
                    Throw-IntentArcAuthorizationManifestInvalid
                }
                $state.Position += 1
            }
        }
        if ($character -ceq '"') {
            [void](Read-IntentArcJsonString)
            return
        }
        foreach ($literal in @('true', 'false', 'null')) {
            if ($state.Position + $literal.Length -le $state.Length -and $Text.Substring($state.Position, $literal.Length) -ceq $literal) {
                $state.Position += $literal.Length
                return
            }
        }
        $number = [Regex]::Match($Text.Substring($state.Position), '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?')
        if (-not $number.Success) {
            Throw-IntentArcAuthorizationManifestInvalid
        }
        $state.Position += $number.Length
    }

    Read-IntentArcJsonValue
    Skip-IntentArcJsonWhitespace
    if ($state.Position -ne $state.Length) {
        Throw-IntentArcAuthorizationManifestInvalid
    }
}

function Assert-IntentArcManifestKeys {
    param(
        [Parameter(Mandatory)] $Value,
        [Parameter(Mandatory)][string[]] $Expected
    )

    if ($Value -isnot [Collections.IDictionary] -or $Value.Count -ne $Expected.Count) {
        Throw-IntentArcAuthorizationManifestInvalid
    }
    $keys = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
    foreach ($key in $Value.Keys) {
        if ($key -isnot [string] -or -not $keys.Add($key)) {
            Throw-IntentArcAuthorizationManifestInvalid
        }
    }
    foreach ($key in $Expected) {
        if (-not $keys.Contains($key)) {
            Throw-IntentArcAuthorizationManifestInvalid
        }
    }
}

function Get-IntentArcManifestString {
    param([Parameter(Mandatory)] $Value)

    if ($Value -isnot [string] -or [string]::IsNullOrEmpty($Value)) {
        Throw-IntentArcAuthorizationManifestInvalid
    }
    return $Value
}

function Assert-IntentArcManifestExactString {
    param([Parameter(Mandatory)] $Value, [Parameter(Mandatory)][string] $Expected)

    if ($Value -isnot [string] -or -not [string]::Equals($Value, $Expected, [StringComparison]::Ordinal)) {
        Throw-IntentArcAuthorizationManifestInvalid
    }
}

function Test-IntentArcWindowsPowerShellLaunchText {
    param(
        [Parameter(Mandatory)][string] $Expected,
        [Parameter(Mandatory)][string] $Actual
    )

    if ([string]::Equals($Expected, $Actual, [StringComparison]::Ordinal)) {
        return $true
    }
    $executable = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
    if (-not $Expected.StartsWith(($executable + ' '), [StringComparison]::Ordinal)) {
        return $false
    }
    $quotedExecutableLaunch = '"' + $executable + '"' + $Expected.Substring($executable.Length)
    return [string]::Equals($quotedExecutableLaunch, $Actual, [StringComparison]::Ordinal)
}

function Assert-IntentArcManifestExactInteger {
    param([Parameter(Mandatory)] $Value, [Parameter(Mandatory)][int] $Expected)

    if ($Value -isnot [int] -or $Value -ne $Expected) {
        Throw-IntentArcAuthorizationManifestInvalid
    }
}

function ConvertTo-IntentArcManifestAbsolutePath {
    param([Parameter(Mandatory)] $Value)

    $path = Get-IntentArcManifestString -Value $Value
    if ($path -notmatch '^[A-Za-z]:[\\/]' -or $path -match '^[\\/]{2}' -or $path -match '[*?\[\]]' -or $path -match '(^|[\\/])\.\.([\\/]|$)' -or $path -notmatch '^[A-Za-z]:[^:]*$') {
        Throw-IntentArcAuthorizationManifestInvalid
    }
    try {
        $fullPath = [IO.Path]::GetFullPath($path).Replace('/', '\')
    } catch {
        Throw-IntentArcAuthorizationManifestInvalid
    }
    if ($fullPath.Length -gt 3) {
        $fullPath = $fullPath.TrimEnd('\')
    }
    foreach ($component in $fullPath.Split('\')) {
        $deviceName = $component.TrimEnd('.', ' ')
        if ($deviceName -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9]|CLOCK\$|CONIN\$|CONOUT\$)(?:\..*)?$') {
            Throw-IntentArcAuthorizationManifestInvalid
        }
    }
    return $fullPath
}

function Assert-IntentArcManifestContainedPath {
    param(
        [Parameter(Mandatory)][string] $Root,
        [Parameter(Mandatory)][string] $Candidate
    )

    $rootPrefix = $Root.TrimEnd('\') + '\'
    if (-not $Candidate.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        Throw-IntentArcAuthorizationManifestInvalid
    }
}

function Assert-IntentArcManifestExactPath {
    param(
        [Parameter(Mandatory)][string] $Value,
        [Parameter(Mandatory)][string] $Expected
    )

    if (-not [string]::Equals($Value, $Expected, [StringComparison]::OrdinalIgnoreCase)) {
        Throw-IntentArcAuthorizationManifestInvalid
    }
}

function ConvertTo-IntentArcOrderedManifestValue {
    param([Parameter(Mandatory)] $Value)

    if ($Value -is [Collections.IDictionary]) {
        $ordered = [ordered]@{}
        foreach ($key in $Value.Keys) {
            $ordered[[string]$key] = ConvertTo-IntentArcOrderedManifestValue -Value $Value[$key]
        }
        return $ordered
    }
    if ($Value -is [Collections.IList]) {
        $items = @()
        foreach ($item in $Value) {
            $items += ,(ConvertTo-IntentArcOrderedManifestValue -Value $item)
        }
        return ,$items
    }
    return $Value
}

function Read-IntentArcSignedAuthorizationManifest {
    param(
        [Parameter(Mandatory)][string] $LiteralPath,
        [Parameter(Mandatory)][string] $ExpectedSha256,
        [Parameter(Mandatory)][string] $ActualInvocation
    )

    if ($ExpectedSha256 -cnotmatch '^[0-9a-f]{64}$') {
        throw 'authorization-manifest-digest'
    }
    try {
        $bytes = [IO.File]::ReadAllBytes($LiteralPath)
        $actualSha256 = Get-IntentArcSha256ForBytes -Bytes $bytes
    } catch {
        throw 'authorization-manifest-digest'
    }
    if (-not [string]::Equals($actualSha256, $ExpectedSha256, [StringComparison]::Ordinal)) {
        throw 'authorization-manifest-digest'
    }

    try {
        $json = [Text.UTF8Encoding]::new($false, $true).GetString($bytes)
        Assert-IntentArcJsonHasNoDuplicateKeys -Text $json
        Add-Type -AssemblyName System.Web.Extensions -ErrorAction Stop
        $parsed = (New-Object Web.Script.Serialization.JavaScriptSerializer).DeserializeObject($json)

        Assert-IntentArcManifestKeys -Value $parsed -Expected @('schema', 'run', 'repository', 'files', 'certificate', 'paths', 'release', 'authorization')
        Assert-IntentArcManifestExactString -Value $parsed['schema'] -Expected 'intentarc.signed-release-authorization/v1'

        $run = $parsed['run']
        Assert-IntentArcManifestKeys -Value $run -Expected @('id', 'maximumAttempts', 'retryCount')
        Assert-IntentArcManifestExactString -Value $run['id'] -Expected 'intentarc-phase1-signed-20260830-03'
        Assert-IntentArcManifestExactInteger -Value $run['maximumAttempts'] -Expected 1
        Assert-IntentArcManifestExactInteger -Value $run['retryCount'] -Expected 0

        $repository = $parsed['repository']
        Assert-IntentArcManifestKeys -Value $repository -Expected @('root', 'commit', 'requiredCleanTrackedWorktree', 'gitExecutablePath', 'gitExecutableSha256')
        $repositoryRoot = ConvertTo-IntentArcManifestAbsolutePath -Value $repository['root']
        $gitExecutablePath = ConvertTo-IntentArcManifestAbsolutePath -Value $repository['gitExecutablePath']
        if ($repository['commit'] -isnot [string] -or $repository['commit'] -cnotmatch '^[0-9a-f]{40}$' -or $repository['requiredCleanTrackedWorktree'] -isnot [bool] -or -not $repository['requiredCleanTrackedWorktree'] -or
            -not [string]::Equals([IO.Path]::GetFileName($gitExecutablePath), 'git.exe', [StringComparison]::OrdinalIgnoreCase) -or
            $repository['gitExecutableSha256'] -isnot [string] -or $repository['gitExecutableSha256'] -cnotmatch '^[0-9a-f]{64}$') {
            Throw-IntentArcAuthorizationManifestInvalid
        }
        $repository['gitExecutablePath'] = $gitExecutablePath

        $files = $parsed['files']
        if ($files -isnot [Collections.IList] -or $files.Count -lt 1) {
            Throw-IntentArcAuthorizationManifestInvalid
        }
        $filePaths = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
        foreach ($file in $files) {
            Assert-IntentArcManifestKeys -Value $file -Expected @('path', 'sha256')
            $filePath = ConvertTo-IntentArcManifestAbsolutePath -Value $file['path']
            Assert-IntentArcManifestContainedPath -Root $repositoryRoot -Candidate $filePath
            if (-not $filePaths.Add($filePath) -or $file['sha256'] -isnot [string] -or $file['sha256'] -cnotmatch '^[0-9a-f]{64}$') {
                Throw-IntentArcAuthorizationManifestInvalid
            }
            $file['path'] = $filePath
        }

        $certificate = $parsed['certificate']
        Assert-IntentArcManifestKeys -Value $certificate -Expected @('subject', 'keyContainerName', 'myStore', 'trustStores', 'rsaBits', 'keySpec', 'provider', 'hashAlgorithm')
        Assert-IntentArcManifestExactString -Value $certificate['subject'] -Expected 'CN=IntentArc Phase 1 intentarc-phase1-signed-20260830-03'
        Assert-IntentArcManifestExactString -Value $certificate['keyContainerName'] -Expected 'IntentArc.Release.intentarc-phase1-signed-20260830-03'
        Assert-IntentArcManifestExactString -Value $certificate['myStore'] -Expected 'Cert:\CurrentUser\My'
        if ($certificate['trustStores'] -isnot [Collections.IList] -or $certificate['trustStores'].Count -ne 2) {
            Throw-IntentArcAuthorizationManifestInvalid
        }
        Assert-IntentArcManifestExactString -Value $certificate['trustStores'][0] -Expected 'Cert:\CurrentUser\Root'
        Assert-IntentArcManifestExactString -Value $certificate['trustStores'][1] -Expected 'Cert:\CurrentUser\TrustedPublisher'
        Assert-IntentArcManifestExactInteger -Value $certificate['rsaBits'] -Expected 3072
        Assert-IntentArcManifestExactString -Value $certificate['keySpec'] -Expected 'Signature'
        Assert-IntentArcManifestExactString -Value $certificate['provider'] -Expected 'Microsoft Software Key Storage Provider'
        Assert-IntentArcManifestExactString -Value $certificate['hashAlgorithm'] -Expected 'SHA256'

        $paths = $parsed['paths']
        Assert-IntentArcManifestKeys -Value $paths -Expected @('pfx', 'cer', 'runtime', 'consumedMarker', 'receipt', 'artifactRoot')
        $runRoot = Join-Path $repositoryRoot '.superpowers\sdd\2026-08-31-signed-release-artifact-parent-recovery\signed-live-20260830-03'
        foreach ($pathKey in @('pfx', 'cer', 'runtime', 'consumedMarker', 'receipt')) {
            $value = ConvertTo-IntentArcManifestAbsolutePath -Value $paths[$pathKey]
            Assert-IntentArcManifestContainedPath -Root $runRoot -Candidate $value
            $paths[$pathKey] = $value
        }
        Assert-IntentArcManifestExactPath -Value $paths['pfx'] -Expected (Join-Path $runRoot 'publisher.pfx')
        Assert-IntentArcManifestExactPath -Value $paths['cer'] -Expected (Join-Path $runRoot 'publisher.cer')
        Assert-IntentArcManifestExactPath -Value $paths['runtime'] -Expected (Join-Path $runRoot 'runtime')
        Assert-IntentArcManifestExactPath -Value $paths['consumedMarker'] -Expected (Join-Path $runRoot 'consumed.json')
        Assert-IntentArcManifestExactPath -Value $paths['receipt'] -Expected (Join-Path $runRoot 'receipt.json')
        $artifactRoot = ConvertTo-IntentArcManifestAbsolutePath -Value $paths['artifactRoot']
        Assert-IntentArcManifestExactPath -Value $artifactRoot -Expected (Join-Path $repositoryRoot '.superpowers\artifacts\intentarc-phase1-signed-20260830-03')
        $paths['artifactRoot'] = $artifactRoot

        $release = $parsed['release']
        Assert-IntentArcManifestKeys -Value $release -Expected @(
            'command', 'executablePath', 'executableSha256',
            'verifierExecutablePath', 'verifierExecutableSha256',
            'verifierScriptPath', 'verifierScriptSha256',
            'signToolPath', 'signToolSha256', 'runtimeClosureSha256',
            'runtimeClosureFileCount', 'runtimeClosureTotalBytes',
            'maximumReleaseInvocations', 'maximumNestedMakeInvocations',
            'bridgeAuthorizedPredecessor', 'externalPublicationCount', 'forbiddenLifecycleCount'
        )
        if ($release['command'] -isnot [Collections.IList] -or $release['command'].Count -ne 2) {
            Throw-IntentArcAuthorizationManifestInvalid
        }
        Assert-IntentArcManifestExactString -Value $release['command'][0] -Expected 'pnpm'
        Assert-IntentArcManifestExactString -Value $release['command'][1] -Expected 'desktop:release'
        $releaseExecutablePath = ConvertTo-IntentArcManifestAbsolutePath -Value $release['executablePath']
        $verifierExecutablePath = ConvertTo-IntentArcManifestAbsolutePath -Value $release['verifierExecutablePath']
        $verifierScriptPath = ConvertTo-IntentArcManifestAbsolutePath -Value $release['verifierScriptPath']
        $signToolPath = ConvertTo-IntentArcManifestAbsolutePath -Value $release['signToolPath']
        if (-not [string]::Equals([IO.Path]::GetFileName($releaseExecutablePath), 'pnpm.exe', [StringComparison]::OrdinalIgnoreCase) -or
            -not [string]::Equals([IO.Path]::GetFileName($verifierExecutablePath), 'node.exe', [StringComparison]::OrdinalIgnoreCase) -or
            -not [string]::Equals([IO.Path]::GetFileName($signToolPath), 'signtool.exe', [StringComparison]::OrdinalIgnoreCase) -or
            $release['executableSha256'] -isnot [string] -or $release['executableSha256'] -cnotmatch '^[0-9a-f]{64}$' -or
            $release['verifierExecutableSha256'] -isnot [string] -or $release['verifierExecutableSha256'] -cnotmatch '^[0-9a-f]{64}$' -or
            $release['verifierScriptSha256'] -isnot [string] -or $release['verifierScriptSha256'] -cnotmatch '^[0-9a-f]{64}$' -or
            $release['signToolSha256'] -isnot [string] -or $release['signToolSha256'] -cnotmatch '^[0-9a-f]{64}$' -or
            $release['runtimeClosureSha256'] -isnot [string] -or $release['runtimeClosureSha256'] -cnotmatch '^[0-9a-f]{64}$' -or
            $release['runtimeClosureFileCount'] -isnot [int] -or $release['runtimeClosureFileCount'] -lt 0 -or $release['runtimeClosureFileCount'] -gt 250000 -or
            (($release['runtimeClosureTotalBytes'] -isnot [int]) -and ($release['runtimeClosureTotalBytes'] -isnot [long])) -or $release['runtimeClosureTotalBytes'] -lt 0 -or $release['runtimeClosureTotalBytes'] -gt 8589934592) {
            Throw-IntentArcAuthorizationManifestInvalid
        }
        Assert-IntentArcManifestExactPath -Value $verifierScriptPath -Expected (Join-Path $repositoryRoot 'scripts\signed-artifact-bundle.mjs')
        $release['executablePath'] = $releaseExecutablePath
        $release['verifierExecutablePath'] = $verifierExecutablePath
        $release['verifierScriptPath'] = $verifierScriptPath
        $release['signToolPath'] = $signToolPath
        Assert-IntentArcManifestExactInteger -Value $release['maximumReleaseInvocations'] -Expected 1
        Assert-IntentArcManifestExactInteger -Value $release['maximumNestedMakeInvocations'] -Expected 1
        Assert-IntentArcManifestExactString -Value $release['bridgeAuthorizedPredecessor'] -Expected 'none'
        Assert-IntentArcManifestExactInteger -Value $release['externalPublicationCount'] -Expected 0
        Assert-IntentArcManifestExactInteger -Value $release['forbiddenLifecycleCount'] -Expected 0

        $authorization = $parsed['authorization']
        Assert-IntentArcManifestKeys -Value $authorization -Expected @('workingDirectory', 'commandTemplate')
        $workingDirectory = ConvertTo-IntentArcManifestAbsolutePath -Value $authorization['workingDirectory']
        Assert-IntentArcManifestExactPath -Value $workingDirectory -Expected $repositoryRoot
        $controllerPath = Join-Path $repositoryRoot 'scripts\signed-release-once.ps1'
        $authorizationManifestPath = Join-Path $runRoot 'signed-live-authorization-manifest.json'
        $expectedTemplate = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -File "' + $controllerPath + '" -Execute -AuthorizationManifest "' + $authorizationManifestPath + '" -ExpectedAuthorizationSha256 {MANIFEST_SHA256}'
        Assert-IntentArcManifestExactString -Value $authorization['commandTemplate'] -Expected $expectedTemplate
        if (([Regex]::Matches($authorization['commandTemplate'], '\{MANIFEST_SHA256\}')).Count -ne 1) {
            Throw-IntentArcAuthorizationManifestInvalid
        }
        $expandedInvocation = $authorization['commandTemplate'].Replace('{MANIFEST_SHA256}', $ExpectedSha256)
        if (-not (Test-IntentArcWindowsPowerShellLaunchText -Expected $expandedInvocation -Actual $ActualInvocation)) {
            Throw-IntentArcAuthorizationManifestInvalid
        }

        $parsed['repository']['root'] = $repositoryRoot
        $parsed['authorization']['workingDirectory'] = $workingDirectory
        return ConvertTo-IntentArcOrderedManifestValue -Value $parsed
    } catch {
        throw 'authorization-manifest-invalid'
    }
}
