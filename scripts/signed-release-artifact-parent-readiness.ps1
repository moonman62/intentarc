function Initialize-IntentArcSignedReleaseArtifactParent {
    param([object[]] $ArgumentsVector = @())

    $schema = 'intentarc.signed-release-artifact-parent-readiness/v1'
    $refuse = {
        param([string] $Category)
        return [ordered]@{ schema = $schema; status = 'REFUSED'; category = $Category }
    }
    $isUnsafePath = {
        param([object] $Value)
        if ($Value -isnot [string] -or [string]::IsNullOrEmpty($Value)) { return $true }
        return $Value.IndexOfAny([char[]]@([char]0, [char]10, [char]13, [char]34, [char]39, [char]42, [char]63, [char]91, [char]93)) -ge 0
    }
    $isFullyQualifiedWindowsPath = {
        param([string] $Value)
        if ($Value -match '^[A-Za-z]:\\') { return $true }
        if ($Value.StartsWith('\\?\', [StringComparison]::Ordinal) -or
            $Value.StartsWith('\\.\', [StringComparison]::Ordinal)) { return $false }
        return $Value -match '^\\\\[^\\]+\\[^\\]+(?:\\|$)'
    }
    $getOrdinaryDirectoryIdentity = {
        param([string] $LiteralPath)
        try {
            if (-not [IO.Directory]::Exists($LiteralPath) -or [IO.File]::Exists($LiteralPath)) { return $null }
            $item = Get-Item -LiteralPath $LiteralPath -Force -ErrorAction Stop
            $attributes = [IO.File]::GetAttributes($LiteralPath)
            if (-not $item.PSIsContainer -or (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { return $null }
            return [ordered]@{
                canonicalPath = [IO.Path]::GetFullPath($item.FullName)
                attributes = [int]$attributes
            }
        } catch { return $null }
    }
    $identityMatches = {
        param($Expected, [string] $LiteralPath)
        $actual = & $getOrdinaryDirectoryIdentity $LiteralPath
        return $null -ne $actual -and
            [string]::Equals([string]$Expected.canonicalPath, [string]$actual.canonicalPath, [StringComparison]::OrdinalIgnoreCase) -and
            $Expected.attributes -eq $actual.attributes
    }
    $probeExactEntry = {
        param([string] $LiteralPath)
        try {
            [void](Get-Item -LiteralPath $LiteralPath -Force -ErrorAction Stop)
            [void][IO.File]::GetAttributes($LiteralPath)
            return 'present'
        } catch [Management.Automation.ItemNotFoundException] {
            return 'absent'
        } catch {
            return 'indeterminate'
        }
    }

    if ($ArgumentsVector.Count -ne 4 -or
        $ArgumentsVector[0] -cne '-RepositoryRoot' -or
        $ArgumentsVector[2] -cne '-ArtifactRoot') {
        return & $refuse 'arguments-invalid'
    }
    $repositoryRoot = $ArgumentsVector[1]
    $artifactRoot = $ArgumentsVector[3]
    $repositoryUnsafe = & $isUnsafePath $repositoryRoot
    if ($repositoryUnsafe -or -not (& $isFullyQualifiedWindowsPath ([string]$repositoryRoot))) {
        return & $refuse 'arguments-invalid'
    }
    $artifactUnsafe = & $isUnsafePath $artifactRoot
    if ($artifactUnsafe -or -not (& $isFullyQualifiedWindowsPath ([string]$artifactRoot))) {
        return & $refuse 'artifact-path-invalid'
    }

    try {
        $canonicalRepository = [IO.Path]::GetFullPath([string]$repositoryRoot)
        $canonicalArtifact = [IO.Path]::GetFullPath([string]$artifactRoot)
    } catch {
        return & $refuse 'arguments-invalid'
    }
    $repositoryIdentity = & $getOrdinaryDirectoryIdentity $canonicalRepository
    if ($null -eq $repositoryIdentity) {
        return & $refuse 'repository-invalid'
    }
    $superpowers = Join-Path $canonicalRepository '.superpowers'
    $superpowersIdentity = & $getOrdinaryDirectoryIdentity $superpowers
    if ($null -eq $superpowersIdentity) {
        return & $refuse 'repository-invalid'
    }

    $expectedParent = [IO.Path]::GetFullPath((Join-Path $canonicalRepository '.superpowers\artifacts'))
    $expectedArtifact = [IO.Path]::GetFullPath((Join-Path $expectedParent 'intentarc-phase1-signed-20260830-03'))
    $expectedStaging = $expectedArtifact + '.staging'
    if (-not [string]::Equals($canonicalArtifact, $expectedArtifact, [StringComparison]::OrdinalIgnoreCase)) {
        return & $refuse 'artifact-path-invalid'
    }

    $parentFileExists = [IO.File]::Exists($expectedParent)
    if ($parentFileExists) {
        return & $refuse 'artifact-parent-invalid'
    }
    $parentDirectoryExists = [IO.Directory]::Exists($expectedParent)
    if (-not $parentDirectoryExists) {
        if (-not (& $identityMatches $repositoryIdentity $canonicalRepository) -or
            -not (& $identityMatches $superpowersIdentity $superpowers)) {
            return & $refuse 'repository-invalid'
        }
        try {
            [void][IO.Directory]::CreateDirectory($expectedParent)
        } catch {
            return & $refuse 'artifact-parent-create-failed'
        }
    }
    $artifactParentIdentity = & $getOrdinaryDirectoryIdentity $expectedParent
    if ($null -eq $artifactParentIdentity) {
        return & $refuse 'artifact-parent-invalid'
    }
    if (-not (& $identityMatches $repositoryIdentity $canonicalRepository) -or
        -not (& $identityMatches $superpowersIdentity $superpowers)) {
        return & $refuse 'repository-invalid'
    }
    $finalState = & $probeExactEntry $expectedArtifact
    $stagingState = & $probeExactEntry $expectedStaging
    if ($finalState -ceq 'present' -or $stagingState -ceq 'present') {
        return & $refuse 'artifact-run-state-used'
    }
    if ($finalState -cne 'absent' -or $stagingState -cne 'absent') {
        return & $refuse 'artifact-parent-invalid'
    }
    if (-not (& $identityMatches $repositoryIdentity $canonicalRepository) -or
        -not (& $identityMatches $superpowersIdentity $superpowers)) {
        return & $refuse 'repository-invalid'
    }
    if (-not (& $identityMatches $artifactParentIdentity $expectedParent)) {
        return & $refuse 'artifact-parent-invalid'
    }
    return [ordered]@{
        schema = $schema
        status = 'PASS'
        artifactParentReady = $true
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    $result = Initialize-IntentArcSignedReleaseArtifactParent -ArgumentsVector @($args)
    $result | ConvertTo-Json -Compress
    if ($result.status -cne 'PASS') { exit 1 }
}
