Set-StrictMode -Version Latest

function Get-IntentArcResidueFileEvidence {
    param([Parameter(Mandatory)][string] $LiteralPath)

    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [IO.File]::ReadAllBytes($LiteralPath)
        return [ordered]@{
            byteSize = $bytes.Length
            sha256 = ([BitConverter]::ToString($algorithm.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
        }
    } finally {
        $algorithm.Dispose()
    }
}

function Test-IntentArcResidueReparsePoint {
    param([Parameter(Mandatory)][string] $LiteralPath)

    return (([IO.File]::GetAttributes($LiteralPath) -band [IO.FileAttributes]::ReparsePoint) -ne 0)
}

function Assert-IntentArcResiduePathComponents {
    param([Parameter(Mandatory)][string] $CanonicalPath)

    try {
        $current = $CanonicalPath.Substring(0, 3)
        if (Test-IntentArcResidueReparsePoint -LiteralPath $current) {
            throw 'residue-projection-reparse-point'
        }
        foreach ($component in $CanonicalPath.Substring(3).Split([char[]]@('\', '/'))) {
            if ([string]::IsNullOrEmpty($component)) {
                continue
            }
            $current = Join-Path $current $component
            if (-not [IO.Directory]::Exists($current) -and -not [IO.File]::Exists($current)) {
                return
            }
            if (Test-IntentArcResidueReparsePoint -LiteralPath $current) {
                throw 'residue-projection-reparse-point'
            }
        }
    } catch {
        if ($_.Exception.Message -eq 'residue-projection-reparse-point') {
            throw 'residue-projection-reparse-point'
        }
        throw 'residue-projection-invalid'
    }
}

function Get-IntentArcResidueProjection {
    param([Parameter(Mandatory)][string] $LiteralRoot)

    try {
        $root = [IO.Path]::GetFullPath($LiteralRoot).TrimEnd([char[]]@('\', '/'))
    } catch {
        throw 'residue-projection-invalid'
    }
    if ([string]::IsNullOrEmpty($root)) {
        throw 'residue-projection-invalid'
    }
    try {
        if (-not [IO.Directory]::Exists($root) -and -not [IO.File]::Exists($root)) {
            return [ordered]@{ root = [ordered]@{ presence = 'missing'; type = $null }; entries = @() }
        }
        Assert-IntentArcResiduePathComponents -CanonicalPath $root
        if ([IO.File]::Exists($root)) {
            return [ordered]@{ root = [ordered]@{ presence = 'present'; type = 'file' }; entries = @() }
        }
    } catch {
        if ($_.Exception.Message -eq 'residue-projection-reparse-point') {
            throw 'residue-projection-reparse-point'
        }
        throw 'residue-projection-invalid'
    }

    $entries = New-Object Collections.ArrayList
    function Add-IntentArcResidueEntries {
        param([Parameter(Mandatory)][string] $DirectoryPath)

        [string[]] $children = [IO.Directory]::GetFileSystemEntries($DirectoryPath)
        [Array]::Sort($children, [StringComparer]::Ordinal)
        foreach ($child in $children) {
            if (Test-IntentArcResidueReparsePoint -LiteralPath $child) {
                throw 'residue-projection-reparse-point'
            }
            Assert-IntentArcResiduePathComponents -CanonicalPath $child
            $relativePath = $child.Substring($root.Length).TrimStart([char[]]@('\', '/')).Replace('/', '\\')
            if ([IO.Directory]::Exists($child)) {
                [void]$entries.Add([ordered]@{ path = $relativePath; type = 'directory'; byteSize = 0; sha256 = $null })
                Add-IntentArcResidueEntries -DirectoryPath $child
                continue
            }
            if ([IO.File]::Exists($child)) {
                $evidence = Get-IntentArcResidueFileEvidence -LiteralPath $child
                Assert-IntentArcResiduePathComponents -CanonicalPath $child
                [void]$entries.Add([ordered]@{ path = $relativePath; type = 'file'; byteSize = $evidence.byteSize; sha256 = $evidence.sha256 })
                continue
            }
            throw 'residue-projection-invalid'
        }
    }

    try {
        Assert-IntentArcResiduePathComponents -CanonicalPath $root
        Add-IntentArcResidueEntries -DirectoryPath $root
        Assert-IntentArcResiduePathComponents -CanonicalPath $root
    } catch {
        if ($_.Exception.Message -eq 'residue-projection-reparse-point') {
            throw 'residue-projection-reparse-point'
        }
        throw 'residue-projection-invalid'
    }
    [string[]] $paths = @($entries.ToArray() | ForEach-Object { $_.path })
    [Array]::Sort($paths, [StringComparer]::Ordinal)
    $sortedEntries = New-Object Collections.ArrayList
    foreach ($path in $paths) {
        foreach ($entry in $entries) {
            if ([string]::Equals($entry.path, $path, [StringComparison]::Ordinal)) {
                [void]$sortedEntries.Add($entry)
                break
            }
        }
    }
    return [ordered]@{ root = [ordered]@{ presence = 'present'; type = 'directory' }; entries = @($sortedEntries.ToArray()) }
}

function Test-IntentArcResidueRelativePath {
    param([Parameter(Mandatory)][string] $Path)

    return (-not [string]::IsNullOrEmpty($Path) -and -not $Path.StartsWith('\\') -and -not $Path.StartsWith('/') -and $Path.IndexOf([char]':') -lt 0 -and $Path.IndexOfAny([char[]]@('*', '?', '[')) -lt 0 -and $Path -notmatch '(^|[\\/])\.{1,2}([\\/]|$)')
}

function Test-IntentArcResidueProperty {
    param([Parameter(Mandatory)] $Value, [Parameter(Mandatory)][string] $Name)

    if ($Value -is [Collections.IDictionary]) {
        return $Value.Contains($Name)
    }
    return $Value.PSObject.Properties[$Name] -ne $null
}

function Compare-IntentArcResidueProjection {
    param(
        [Parameter(Mandatory)] $Expected,
        [Parameter(Mandatory)] $Actual
    )

    if (-not (Test-IntentArcResidueProperty -Value $Expected -Name 'root') -or -not (Test-IntentArcResidueProperty -Value $Actual -Name 'root') -or -not (Test-IntentArcResidueProperty -Value $Expected -Name 'entries') -or -not (Test-IntentArcResidueProperty -Value $Actual -Name 'entries') -or -not (Test-IntentArcResidueProperty -Value $Expected.root -Name 'presence') -or -not (Test-IntentArcResidueProperty -Value $Actual.root -Name 'presence') -or -not (Test-IntentArcResidueProperty -Value $Expected.root -Name 'type') -or -not (Test-IntentArcResidueProperty -Value $Actual.root -Name 'type')) {
        throw 'residue-projection-invalid'
    }
    if ($Expected.root.presence -isnot [string] -or $Actual.root.presence -isnot [string] -or -not [string]::Equals($Expected.root.presence, $Actual.root.presence, [StringComparison]::Ordinal)) {
        return [ordered]@{ equal = $false; differences = @([ordered]@{ category = 'root-presence-mismatch' }) }
    }
    if (-not [object]::Equals($Expected.root.type, $Actual.root.type)) {
        return [ordered]@{ equal = $false; differences = @([ordered]@{ category = 'root-type-mismatch' }) }
    }
    $expectedEntries = New-Object 'Collections.Generic.Dictionary[string, object]' ([StringComparer]::OrdinalIgnoreCase)
    $actualEntries = New-Object 'Collections.Generic.Dictionary[string, object]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in @($Expected.entries)) {
        if ($entry.path -isnot [string] -or -not (Test-IntentArcResidueRelativePath -Path $entry.path) -or $expectedEntries.ContainsKey($entry.path)) {
            throw 'residue-projection-invalid'
        }
        $expectedEntries.Add($entry.path, $entry)
    }
    foreach ($entry in @($Actual.entries)) {
        if ($entry.path -isnot [string] -or -not (Test-IntentArcResidueRelativePath -Path $entry.path) -or $actualEntries.ContainsKey($entry.path)) {
            throw 'residue-projection-invalid'
        }
        $actualEntries.Add($entry.path, $entry)
    }

    $paths = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($path in $expectedEntries.Keys) { [void]$paths.Add($path) }
    foreach ($path in $actualEntries.Keys) { [void]$paths.Add($path) }
    [string[]] $orderedPaths = @($paths)
    [Array]::Sort($orderedPaths, [StringComparer]::Ordinal)
    $differences = New-Object Collections.ArrayList
    foreach ($path in $orderedPaths) {
        $hasExpected = $expectedEntries.ContainsKey($path)
        $hasActual = $actualEntries.ContainsKey($path)
        if (-not $hasExpected) {
            [void]$differences.Add([ordered]@{ category = 'extra-entry'; path = $path })
            continue
        }
        if (-not $hasActual) {
            [void]$differences.Add([ordered]@{ category = 'missing-entry'; path = $path })
            continue
        }
        $expectedEntry = $expectedEntries[$path]
        $actualEntry = $actualEntries[$path]
        if (-not [string]::Equals([string]$expectedEntry.type, [string]$actualEntry.type, [StringComparison]::Ordinal)) {
            [void]$differences.Add([ordered]@{ category = 'entry-type-mismatch'; path = $path })
            continue
        }
        if ($expectedEntry.byteSize -ne $actualEntry.byteSize) {
            [void]$differences.Add([ordered]@{ category = 'entry-byte-size-mismatch'; path = $path })
        }
        if (-not [string]::Equals([string]$expectedEntry.sha256, [string]$actualEntry.sha256, [StringComparison]::Ordinal)) {
            [void]$differences.Add([ordered]@{ category = 'entry-sha256-mismatch'; path = $path })
        }
    }
    return [ordered]@{ equal = ($differences.Count -eq 0); differences = @($differences.ToArray()) }
}

function Test-IntentArcCleanupCandidateSyntax {
    param([Parameter(Mandatory)][AllowEmptyString()][string] $LiteralPath)

    if ([string]::IsNullOrEmpty($LiteralPath) -or $LiteralPath -notmatch '^[A-Za-z]:[\\/]' -or $LiteralPath.StartsWith('\\') -or $LiteralPath.StartsWith('/') -or $LiteralPath.IndexOfAny([char[]]@('*', '?', '[')) -ge 0 -or $LiteralPath -match '(^|[\\/])\.\.([\\/]|$)' -or $LiteralPath.IndexOf([char]':', 2) -ge 0 -or $LiteralPath -match '^[A-Za-z]:[\\/]*$') {
        return $false
    }
    foreach ($component in $LiteralPath.Split([char[]]@('\', '/'))) {
        $deviceName = $component.TrimEnd([char[]]@('.', ' '))
        if ($deviceName -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9]|CLOCK\$|CONIN\$|CONOUT\$)(?:\..*)?$') {
            return $false
        }
    }
    return $true
}

function Get-IntentArcValidatedCleanupTarget {
    param(
        [Parameter(Mandatory)][string] $LiteralRoot,
        [AllowNull()][AllowEmptyString()][string] $LiteralCandidate
    )

    if (-not (Test-IntentArcCleanupCandidateSyntax -LiteralPath $LiteralRoot)) {
        throw 'cleanup-root-invalid'
    }
    if (-not (Test-IntentArcCleanupCandidateSyntax -LiteralPath $LiteralCandidate)) {
        throw 'cleanup-target-invalid'
    }
    try {
        $root = [IO.Path]::GetFullPath($LiteralRoot).TrimEnd([char[]]@('\', '/'))
        $candidate = [IO.Path]::GetFullPath($LiteralCandidate).TrimEnd([char[]]@('\', '/'))
    } catch {
        throw 'cleanup-target-invalid'
    }
    if (-not [IO.Directory]::Exists($root) -or (-not [IO.Directory]::Exists($candidate) -and -not [IO.File]::Exists($candidate))) {
        throw 'cleanup-target-unresolved'
    }
    try {
        Assert-IntentArcResiduePathComponents -CanonicalPath $root
        Assert-IntentArcResiduePathComponents -CanonicalPath $candidate
    } catch {
        if ($_.Exception.Message -eq 'residue-projection-reparse-point') {
            throw 'cleanup-target-reparse-point'
        }
        throw 'cleanup-target-invalid'
    }
    if ([string]::Equals($root, $candidate, [StringComparison]::OrdinalIgnoreCase)) {
        return $candidate
    }
    $rootPrefix = $root + [IO.Path]::DirectorySeparatorChar
    if ($candidate.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        return $candidate
    }
    throw 'cleanup-target-outside-root'
}

function Confirm-IntentArcValidatedCleanupTarget {
    param(
        [Parameter(Mandatory)][string] $LiteralRoot,
        [Parameter(Mandatory)][string] $CanonicalTarget
    )

    try {
        [void](Get-IntentArcValidatedCleanupTarget -LiteralRoot $LiteralRoot -LiteralCandidate $CanonicalTarget)
        return 'cleanup-target-contained'
    } catch {
        if ($_.Exception.Message -in @('cleanup-root-invalid', 'cleanup-target-invalid', 'cleanup-target-unresolved', 'cleanup-target-reparse-point', 'cleanup-target-outside-root')) {
            return $_.Exception.Message
        }
        return 'cleanup-target-invalid'
    }
}

function Test-IntentArcCleanupContainment {
    param(
        [Parameter(Mandatory)][string] $LiteralRoot,
        [AllowNull()][AllowEmptyString()][string] $LiteralCandidate
    )

    try {
        [void](Get-IntentArcValidatedCleanupTarget -LiteralRoot $LiteralRoot -LiteralCandidate $LiteralCandidate)
        return 'cleanup-target-contained'
    } catch {
        return $_.Exception.Message
    }
}

function New-IntentArcBoundedResidueSummary {
    param([Parameter(Mandatory)] $Counts)

    $keys = @('myCertificate', 'rootTrust', 'trustedPublisherTrust', 'cngKey', 'pfx', 'cer', 'runtime', 'process', 'signingEnvironment', 'generatedDist', 'generatedOut', 'recoveryDirectory')
    if ($Counts -isnot [Collections.IDictionary] -or $Counts.Count -ne $keys.Count) {
        throw 'bounded-residue-invalid'
    }
    $summary = [ordered]@{}
    foreach ($key in $keys) {
        if (-not $Counts.Contains($key) -or $Counts[$key] -isnot [int] -or $Counts[$key] -lt 0) {
            throw 'bounded-residue-invalid'
        }
        $summary[$key] = $Counts[$key]
    }
    foreach ($key in $Counts.Keys) {
        if ($key -isnot [string] -or $key -notin $keys) {
            throw 'bounded-residue-invalid'
        }
    }
    return $summary
}
