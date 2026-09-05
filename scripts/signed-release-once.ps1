[CmdletBinding()]
param(
    [switch] $Execute,
    [string] $AuthorizationManifest,
    [string] $ExpectedAuthorizationSha256,
    [switch] $StaticSelfTest
)

. (Join-Path $PSScriptRoot 'signed-release-once-manifest.ps1')
. (Join-Path $PSScriptRoot 'signed-release-once-residue.ps1')

function Get-IntentArcSignedReleaseOperationNames {
    return @(
        'GetRepositoryState',
        'GetFileHash',
        'BindExecutionInputs',
        'GetTrackedFileInventory',
        'GetRuntimeClosure',
        'GetBeforeProjection',
        'CreateConsumedMarkerAtomic',
        'PreserveOutputRoot',
        'PrepareCertificate',
        'AddTrust',
        'VerifyTrust',
        'SetSigningEnvironment',
        'InvokeRelease',
        'VerifyRelease',
        'PublishClosedArtifactBundle',
        'SettleDescendants',
        'ClearSigningEnvironment',
        'RemoveTrust',
        'RemoveCertificate',
        'RemoveCngKey',
        'RemoveExactFile',
        'RemoveRuntime',
        'RemovePartialArtifactBundle',
        'RemoveGeneratedOutput',
        'RestoreOutputRoot',
        'GetAfterProjection',
        'WriteReceiptAtomic'
    )
}

function Test-IntentArcSignedReleaseOperations {
    param([Parameter(Mandatory)][hashtable] $Operations)

    $expected = @(Get-IntentArcSignedReleaseOperationNames)
    if ($Operations.Count -ne $expected.Count) {
        return $false
    }
    foreach ($name in $expected) {
        if (-not $Operations.ContainsKey($name) -or $Operations[$name] -isnot [scriptblock]) {
            return $false
        }
    }
    return $true
}

function Test-IntentArcSignedReleaseRecord {
    param(
        [AllowNull()] $Value,
        [Parameter(Mandatory)][string[]] $Keys
    )

    if ($Value -isnot [Collections.IDictionary] -or $Value.Count -ne $Keys.Count) {
        return $false
    }
    foreach ($key in $Keys) {
        if (-not $Value.Contains($key)) {
            return $false
        }
    }
    return $true
}

function New-IntentArcSignedReleaseResult {
    param(
        [Parameter(Mandatory)][ValidateSet('PASS', 'FAIL', 'REFUSED')][string] $Status,
        [Parameter(Mandatory)][string] $PrimaryCategory,
        [Parameter(Mandatory)][ValidateSet('validated', 'consumed', 'prepared', 'released', 'verified', 'cleaned')][string] $HighestCompletedState,
        [Parameter(Mandatory)][int] $ReleaseInvocations,
        [Parameter(Mandatory)][int] $NestedMakeInvocations,
        [Parameter(Mandatory)][int] $ForbiddenLifecycleCount,
        [Parameter(Mandatory)][int] $ExternalPublicationCount,
        [Parameter(Mandatory)][bool] $MarkerConsumed
    )

    return [ordered]@{
        status = $Status
        primaryCategory = $PrimaryCategory
        highestCompletedState = $HighestCompletedState
        releaseInvocations = $ReleaseInvocations
        nestedMakeInvocations = $NestedMakeInvocations
        forbiddenLifecycleCount = $ForbiddenLifecycleCount
        externalPublicationCount = $ExternalPublicationCount
        markerConsumed = $MarkerConsumed
    }
}

function New-IntentArcSignedReleaseRefusal {
    param(
        [Parameter(Mandatory)][string] $Category,
        [ValidateSet('validated', 'consumed')][string] $HighestCompletedState = 'validated',
        [bool] $MarkerConsumed = $false
    )

    return New-IntentArcSignedReleaseResult `
        -Status 'REFUSED' `
        -PrimaryCategory $Category `
        -HighestCompletedState $HighestCompletedState `
        -ReleaseInvocations 0 `
        -NestedMakeInvocations 0 `
        -ForbiddenLifecycleCount 0 `
        -ExternalPublicationCount 0 `
        -MarkerConsumed $MarkerConsumed
}

function Resolve-IntentArcSignedReleasePrimaryCategory {
    param(
        [Parameter(Mandatory)][string] $DefaultCategory,
        [AllowNull()] $Failure
    )

    if ($null -ne $Failure -and $null -ne $Failure.Exception -and
        $Failure.Exception.Message -cin @('interruption', 'timeout')) {
        return $Failure.Exception.Message.ToLowerInvariant()
    }
    $allowed = if ($DefaultCategory -ceq 'certificate-create') {
        @('certificate-create', 'private-key-open', 'certificate-export', 'public-certificate-export', 'thumbprint-verify')
    } elseif ($DefaultCategory -ceq 'signature-verification') {
        @('signature-verification', 'bridge-predecessor-verification', 'artifact-verification')
    } elseif ($DefaultCategory -ceq 'closed-bundle-publication') {
        @('signature-verification', 'bridge-predecessor-verification', 'artifact-verification', 'bridge-diagnostic-audit')
    } elseif ($DefaultCategory -ceq 'release') {
        @('bridge-diagnostic-audit')
    } else {
        @()
    }
    $message = if ($null -ne $Failure -and $null -ne $Failure.Exception) {
        [string]$Failure.Exception.Message
    } else {
        ''
    }
    if ($message -in $allowed) {
        return $message
    }
    $match = [Regex]::Match($message, '^IntentArc signing certificate preparation failed: ([a-z-]+)\.$')
    if ($match.Success -and $match.Groups[1].Value -in $allowed) {
        return $match.Groups[1].Value
    }
    return $DefaultCategory
}

function Assert-IntentArcSignedReleaseContinuation {
    param(
        [Parameter(Mandatory)][Threading.CancellationToken] $CancellationToken,
        [Parameter(Mandatory)][DateTime] $DeadlineUtc
    )

    if ($CancellationToken.IsCancellationRequested) {
        throw 'interruption'
    }
    if ([DateTime]::UtcNow -ge $DeadlineUtc) {
        throw 'timeout'
    }
}

function Invoke-IntentArcSignedReleaseCleanupAttempt {
    param(
        [Parameter(Mandatory)][string] $Category,
        [Parameter(Mandatory)][AllowEmptyCollection()][Collections.ArrayList] $CleanupCategories,
        [Parameter(Mandatory)][scriptblock] $Operation,
        [object[]] $Arguments = @(),
        [scriptblock] $Validator
    )

    try {
        $value = & $Operation @Arguments
        if ($null -ne $Validator -and -not (& $Validator $value)) {
            throw 'cleanup-result-invalid'
        }
        return $value
    } catch {
        [void]$CleanupCategories.Add($Category)
        return $null
    }
}

function Test-IntentArcSignedReleaseReceipt {
    param(
        [AllowNull()] $Receipt,
        [Parameter(Mandatory)][string] $ExpectedRunId
    )

    $expectedKeys = @(
        'schema',
        'runId',
        'commit',
        'manifestSha256',
        'status',
        'highestCompletedState',
        'primaryCategory',
        'cleanupCategories',
        'releaseInvocationCount',
        'nestedMakeInvocationCount',
        'forbiddenLifecycleInvocationCount',
        'externalPublicationInvocationCount',
        'bridgeDiagnosticInvocationCount',
        'residue',
        'artifactManifestSha256',
        'startedAtUtc',
        'completedAtUtc'
    )
    $record = [ordered]@{}
    if ($Receipt -is [Collections.IDictionary]) {
        foreach ($key in $Receipt.Keys) { $record[[string]$key] = $Receipt[$key] }
    } elseif ($null -ne $Receipt -and $Receipt -is [psobject]) {
        foreach ($property in $Receipt.PSObject.Properties) { $record[$property.Name] = $property.Value }
    } else {
        return $false
    }
    if (-not (Test-IntentArcSignedReleaseRecord -Value $record -Keys $expectedKeys)) { return $false }
    $primaryCategories = @(
        'none', 'bridge-diagnostic-audit', 'output-preservation',
        'certificate-create', 'private-key-open', 'certificate-export', 'public-certificate-export', 'thumbprint-verify',
        'root-trust', 'trusted-publisher-trust', 'trust-verification', 'signing-environment',
        'release', 'release-result-invalid', 'descendant-settlement', 'signature-verification',
        'bridge-predecessor-verification', 'artifact-verification', 'closed-bundle-publication',
        'interruption', 'timeout'
    )
    $cleanupCategoryAllowlist = @(
        'descendant-settlement', 'signing-environment-clear', 'root-trust-removal', 'trusted-publisher-trust-removal',
        'my-certificate-removal', 'cng-key-removal', 'pfx-removal', 'cer-removal', 'runtime-removal',
        'artifact-bundle-staging-rollback', 'artifact-bundle-final-rollback',
        'generated-dist-removal', 'generated-out-removal', 'output-restoration', 'after-projection', 'residue-proof'
    )
    if ($ExpectedRunId.Length -lt 1 -or $ExpectedRunId.Length -gt 128 -or
        $record.schema -isnot [string] -or $record.schema -cne 'intentarc.signed-release-receipt/v3' -or
        $record.runId -isnot [string] -or $record.runId.Length -lt 1 -or $record.runId.Length -gt 128 -or
        -not [string]::Equals($record.runId, $ExpectedRunId, [StringComparison]::Ordinal) -or
        $record.commit -isnot [string] -or $record.commit -cnotmatch '^[0-9a-f]{40}$' -or
        $record.manifestSha256 -isnot [string] -or $record.manifestSha256 -cnotmatch '^[0-9a-f]{64}$' -or
        $record.status -isnot [string] -or $record.status -cnotin @('PASS', 'FAIL') -or
        $record.highestCompletedState -isnot [string] -or $record.highestCompletedState -cnotin @('validated', 'consumed', 'prepared', 'released', 'verified', 'cleaned') -or
        $record.primaryCategory -isnot [string] -or $record.primaryCategory -cnotin $primaryCategories -or
        $record.cleanupCategories -isnot [object[]] -or $record.cleanupCategories.Count -gt 16 -or
        $record.artifactManifestSha256 -isnot [string] -or ($record.artifactManifestSha256.Length -ne 0 -and $record.artifactManifestSha256 -cnotmatch '^[0-9a-f]{64}$') -or
        $record.startedAtUtc -isnot [string] -or $record.startedAtUtc -cnotmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$' -or
        $record.completedAtUtc -isnot [string] -or $record.completedAtUtc -cnotmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$') {
        return $false
    }
    foreach ($category in $record.cleanupCategories) {
        if ($category -isnot [string] -or $category -cnotin $cleanupCategoryAllowlist) { return $false }
    }
    [DateTime]$startedAtUtc = [DateTime]::MinValue
    [DateTime]$completedAtUtc = [DateTime]::MinValue
    $dateStyles = [Globalization.DateTimeStyles]::RoundtripKind
    if (-not [DateTime]::TryParseExact($record.startedAtUtc, 'o', [Globalization.CultureInfo]::InvariantCulture, $dateStyles, [ref]$startedAtUtc) -or
        -not [DateTime]::TryParseExact($record.completedAtUtc, 'o', [Globalization.CultureInfo]::InvariantCulture, $dateStyles, [ref]$completedAtUtc) -or
        $startedAtUtc.Kind -ne [DateTimeKind]::Utc -or $completedAtUtc.Kind -ne [DateTimeKind]::Utc -or $completedAtUtc -lt $startedAtUtc) {
        return $false
    }
    foreach ($countKey in @('releaseInvocationCount', 'nestedMakeInvocationCount', 'forbiddenLifecycleInvocationCount', 'externalPublicationInvocationCount', 'bridgeDiagnosticInvocationCount')) {
        if ($record[$countKey] -isnot [int] -or $record[$countKey] -lt 0) { return $false }
    }

    $residueKeys = @('myCertificate', 'rootTrust', 'trustedPublisherTrust', 'cngKey', 'pfx', 'cer', 'runtime', 'process', 'signingEnvironment', 'generatedDist', 'generatedOut', 'recoveryDirectory')
    $residue = [ordered]@{}
    if ($record.residue -is [Collections.IDictionary]) {
        foreach ($key in $record.residue.Keys) { $residue[[string]$key] = $record.residue[$key] }
    } elseif ($null -ne $record.residue -and $record.residue -is [psobject]) {
        foreach ($property in $record.residue.PSObject.Properties) { $residue[$property.Name] = $property.Value }
    } else {
        return $false
    }
    if (-not (Test-IntentArcSignedReleaseRecord -Value $residue -Keys $residueKeys)) { return $false }
    foreach ($key in $residueKeys) {
        if ($residue[$key] -isnot [int] -or $residue[$key] -lt 0) { return $false }
    }
    return $true
}

function Write-IntentArcSignedReleaseReceiptAtomic {
    param(
        [Parameter(Mandatory)][string] $LiteralPath,
        [Parameter(Mandatory)] $Receipt,
        [Parameter(Mandatory)][string] $ExpectedRunId,
        [scriptblock] $OpenFile
    )

    if (-not (Test-IntentArcSignedReleaseReceipt -Receipt $Receipt -ExpectedRunId $ExpectedRunId)) { throw 'receipt-writing' }
    $directory = Split-Path -Parent $LiteralPath
    if (-not (Test-IntentArcCleanupCandidateSyntax -LiteralPath $LiteralPath)) {
        throw 'receipt-writing'
    }
    $canonicalDirectory = Get-IntentArcValidatedCleanupTarget -LiteralRoot $directory -LiteralCandidate $directory
    if ((Confirm-IntentArcValidatedCleanupTarget -LiteralRoot $directory -CanonicalTarget $canonicalDirectory) -cne 'cleanup-target-contained') {
        throw 'receipt-writing'
    }
    $temporaryPath = $LiteralPath + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    $stream = $null
    $operationFailed = $false
    $cleanupFailed = $false
    try {
        $stream = if ($null -eq $OpenFile) {
            [IO.File]::Open($temporaryPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        } else {
            & $OpenFile $temporaryPath
        }
        $json = $Receipt | ConvertTo-Json -Depth 8 -Compress
        $bytes = [Text.UTF8Encoding]::new($false, $true).GetBytes($json)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
        $stream.Dispose()
        $stream = $null

        $canonicalTemporary = Get-IntentArcConfirmedExistingTarget -LiteralRoot $directory -LiteralCandidate $temporaryPath
        if ([IO.File]::Exists($LiteralPath) -or [IO.Directory]::Exists($LiteralPath)) {
            throw 'receipt-writing'
        }
        [void](Get-IntentArcConfirmedExistingTarget -LiteralRoot $directory -LiteralCandidate $directory)
        $canonicalTemporary = Get-IntentArcConfirmedExistingTarget -LiteralRoot $directory -LiteralCandidate $temporaryPath
        [IO.File]::Move($canonicalTemporary, $LiteralPath)
        [void](Get-IntentArcConfirmedExistingTarget -LiteralRoot $directory -LiteralCandidate $LiteralPath)
    } catch {
        $operationFailed = $true
    } finally {
        if ($null -ne $stream) {
            try { $stream.Dispose() } catch { $cleanupFailed = $true }
        }
        if ([IO.File]::Exists($temporaryPath)) {
            try {
                $canonicalTemporary = Get-IntentArcConfirmedExistingTarget -LiteralRoot $directory -LiteralCandidate $temporaryPath
                [IO.File]::Delete($canonicalTemporary)
                if ([IO.File]::Exists($temporaryPath) -or [IO.Directory]::Exists($temporaryPath)) { throw 'receipt-writing' }
            } catch { $cleanupFailed = $true }
        }
    }
    if ($operationFailed -or $cleanupFailed) { throw 'receipt-writing' }
}

function Test-IntentArcSignedReleaseInvocation {
    param(
        [Parameter(Mandatory)] $Manifest,
        [Parameter(Mandatory)][string] $ActualInvocation
    )

    if ([string]::IsNullOrEmpty($ActualInvocation) -or $ActualInvocation.Length -gt 32768) {
        return $false
    }
    $match = [Regex]::Match($ActualInvocation, ' -ExpectedAuthorizationSha256 ([0-9a-f]{64})$')
    if (-not $match.Success) {
        return $false
    }
    $expected = [string]$Manifest.authorization.commandTemplate
    if (([Regex]::Matches($expected, '\{MANIFEST_SHA256\}')).Count -ne 1) {
        return $false
    }
    $expected = $expected.Replace('{MANIFEST_SHA256}', $match.Groups[1].Value)
    return Test-IntentArcWindowsPowerShellLaunchText -Expected $expected -Actual $ActualInvocation
}

function Invoke-IntentArcSignedReleaseOnce {
    param(
        [Parameter(Mandatory)] $Manifest,
        [Parameter(Mandatory)][hashtable] $Operations,
        [Parameter(Mandatory)][string] $ActualInvocation,
        [Threading.CancellationToken] $CancellationToken = [Threading.CancellationToken]::None,
        [DateTime] $DeadlineUtc = ([DateTime]::UtcNow.AddHours(2))
    )

    $startedAtUtc = [DateTime]::UtcNow.ToString('o')
    if ($DeadlineUtc -gt [DateTime]::UtcNow.AddHours(2)) {
        throw 'controller-control-invalid'
    }
    if (-not (Test-IntentArcSignedReleaseOperations -Operations $Operations)) {
        throw 'controller-operations-invalid'
    }
    if (-not (Test-IntentArcSignedReleaseInvocation -Manifest $Manifest -ActualInvocation $ActualInvocation)) {
        return New-IntentArcSignedReleaseRefusal -Category 'authorization-invocation'
    }

    $executionBindingKeys = @(
        'releaseExecutablePath', 'releaseExecutableSha256',
        'verifierExecutablePath', 'verifierExecutableSha256',
        'verifierScriptPath', 'verifierScriptSha256',
        'gitExecutablePath', 'gitExecutableSha256', 'signToolPath', 'signToolSha256',
        'runtimeHelperSha256', 'commandLineProbeSha256', 'artifactParentReady', 'packageBinReady'
    )
    try {
        $executionBinding = & $Operations['BindExecutionInputs'] $Manifest
    } catch {
        return New-IntentArcSignedReleaseRefusal -Category 'execution-input-binding'
    }
    if (-not (Test-IntentArcSignedReleaseRecord -Value $executionBinding -Keys $executionBindingKeys) -or
        $executionBinding.artifactParentReady -isnot [bool] -or -not $executionBinding.artifactParentReady -or
        $executionBinding.packageBinReady -isnot [bool] -or -not $executionBinding.packageBinReady -or
        -not [string]::Equals([string]$executionBinding.releaseExecutablePath, [string]$Manifest.release.executablePath, [StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals([string]$executionBinding.releaseExecutableSha256, [string]$Manifest.release.executableSha256, [StringComparison]::Ordinal) -or
        -not [string]::Equals([string]$executionBinding.verifierExecutablePath, [string]$Manifest.release.verifierExecutablePath, [StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals([string]$executionBinding.verifierExecutableSha256, [string]$Manifest.release.verifierExecutableSha256, [StringComparison]::Ordinal) -or
        -not [string]::Equals([string]$executionBinding.verifierScriptPath, [string]$Manifest.release.verifierScriptPath, [StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals([string]$executionBinding.verifierScriptSha256, [string]$Manifest.release.verifierScriptSha256, [StringComparison]::Ordinal) -or
        -not [string]::Equals([string]$executionBinding.gitExecutablePath, [string]$Manifest.repository.gitExecutablePath, [StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals([string]$executionBinding.gitExecutableSha256, [string]$Manifest.repository.gitExecutableSha256, [StringComparison]::Ordinal) -or
        -not [string]::Equals([string]$executionBinding.signToolPath, [string]$Manifest.release.signToolPath, [StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals([string]$executionBinding.signToolSha256, [string]$Manifest.release.signToolSha256, [StringComparison]::Ordinal) -or
        $executionBinding.runtimeHelperSha256 -isnot [string] -or $executionBinding.runtimeHelperSha256 -cnotmatch '^[0-9a-f]{64}$' -or
        $executionBinding.commandLineProbeSha256 -isnot [string] -or $executionBinding.commandLineProbeSha256 -cnotmatch '^[0-9a-f]{64}$') {
        return New-IntentArcSignedReleaseRefusal -Category 'execution-input-binding'
    }

    try { $repositoryState = & $Operations['GetRepositoryState'] $Manifest } catch { return New-IntentArcSignedReleaseRefusal -Category 'repository-state-invalid' }
    if (-not (Test-IntentArcSignedReleaseRecord -Value $repositoryState -Keys @('clean', 'commit')) -or $repositoryState.clean -isnot [bool]) { return New-IntentArcSignedReleaseRefusal -Category 'repository-state-invalid' }
    if (-not $repositoryState.clean) { return New-IntentArcSignedReleaseRefusal -Category 'repository-dirty' }
    if (-not [string]::Equals([string]$repositoryState.commit, [string]$Manifest.repository.commit, [StringComparison]::Ordinal)) { return New-IntentArcSignedReleaseRefusal -Category 'repository-commit' }
    try { $trackedFiles = @(& $Operations['GetTrackedFileInventory'] $Manifest) } catch { return New-IntentArcSignedReleaseRefusal -Category 'tracked-file-inventory' }
    [string[]]$manifestPaths = @($Manifest.files | ForEach-Object { [IO.Path]::GetFullPath([string]$_.path) })
    [string[]]$trackedPaths = @($trackedFiles | ForEach-Object { if ($_ -isnot [string]) { throw 'tracked-file-inventory' }; [IO.Path]::GetFullPath([string]$_) })
    [Array]::Sort($manifestPaths, [StringComparer]::Ordinal)
    [Array]::Sort($trackedPaths, [StringComparer]::Ordinal)
    if ($trackedPaths.Count -ne $manifestPaths.Count) { return New-IntentArcSignedReleaseRefusal -Category 'tracked-file-inventory' }
    for ($index = 0; $index -lt $manifestPaths.Count; $index++) { if (-not [string]::Equals($trackedPaths[$index], $manifestPaths[$index], [StringComparison]::Ordinal)) { return New-IntentArcSignedReleaseRefusal -Category 'tracked-file-inventory' } }
    foreach ($file in $Manifest.files) {
        try { $observedHash = & $Operations['GetFileHash'] $file.path } catch { return New-IntentArcSignedReleaseRefusal -Category 'bound-file-hash' }
        if ($observedHash -isnot [string] -or -not [string]::Equals($observedHash, [string]$file.sha256, [StringComparison]::Ordinal)) { return New-IntentArcSignedReleaseRefusal -Category 'bound-file-hash' }
    }
    try { $runtimeClosure = & $Operations['GetRuntimeClosure'] $Manifest } catch { return New-IntentArcSignedReleaseRefusal -Category 'runtime-closure-invalid' }
    if (-not (Test-IntentArcSignedReleaseRecord -Value $runtimeClosure -Keys @('sha256', 'fileCount', 'totalBytes')) -or
        $runtimeClosure.sha256 -isnot [string] -or -not [string]::Equals($runtimeClosure.sha256, [string]$Manifest.release.runtimeClosureSha256, [StringComparison]::Ordinal) -or
        $runtimeClosure.fileCount -isnot [int] -or $runtimeClosure.fileCount -ne $Manifest.release.runtimeClosureFileCount -or
        (($runtimeClosure.totalBytes -isnot [int]) -and ($runtimeClosure.totalBytes -isnot [long])) -or $runtimeClosure.totalBytes -ne $Manifest.release.runtimeClosureTotalBytes) {
        return New-IntentArcSignedReleaseRefusal -Category 'runtime-closure-invalid'
    }

    $beforeKeys = @(
        'outputProjectionValid', 'consumedMarker', 'myCertificate', 'rootTrust',
        'trustedPublisherTrust', 'cngKey', 'pfx', 'cer', 'runtime',
        'artifactRoot', 'signingEnvironment'
    )
    try {
        $before = & $Operations['GetBeforeProjection'] $Manifest
    } catch {
        return New-IntentArcSignedReleaseRefusal -Category 'output-projection-invalid'
    }
    if (-not (Test-IntentArcSignedReleaseRecord -Value $before -Keys $beforeKeys) -or $before.outputProjectionValid -isnot [bool] -or -not $before.outputProjectionValid) {
        return New-IntentArcSignedReleaseRefusal -Category 'output-projection-invalid'
    }
    foreach ($key in $beforeKeys[1..($beforeKeys.Count - 1)]) {
        if ($before[$key] -isnot [int] -or $before[$key] -lt 0) {
            return New-IntentArcSignedReleaseRefusal -Category 'output-projection-invalid'
        }
    }
    if ($before.consumedMarker -ne 0) {
        return New-IntentArcSignedReleaseRefusal -Category 'attempt-already-consumed'
    }
    if ($before.signingEnvironment -ne 0) {
        return New-IntentArcSignedReleaseRefusal -Category 'signing-environment-active'
    }
    foreach ($key in @('myCertificate', 'rootTrust', 'trustedPublisherTrust', 'cngKey', 'pfx', 'cer', 'runtime', 'artifactRoot')) {
        if ($before[$key] -ne 0) {
            return New-IntentArcSignedReleaseRefusal -Category 'preflight-residue'
        }
    }

    $marker = [ordered]@{
        schema = 'intentarc.signed-release-consumed/v1'
        runId = [string]$Manifest.run.id
        maximumAttempts = 1
    }
    try {
        $markerCreated = & $Operations['CreateConsumedMarkerAtomic'] $Manifest.paths.consumedMarker $marker
    } catch {
        return New-IntentArcSignedReleaseRefusal -Category 'attempt-consumption-race'
    }
    if ($markerCreated -isnot [bool] -or -not $markerCreated) {
        return New-IntentArcSignedReleaseRefusal -Category 'attempt-consumption-race'
    }

    $highestCompletedState = 'consumed'
    $primaryCategory = 'none'
    $cleanupCategories = New-Object Collections.ArrayList
    $releaseInvocations = 0
    $nestedMakeInvocations = 0
    $forbiddenLifecycleCount = 0
    $controllerState = [ordered]@{ externalPublicationInvocationCount = 0 }
    $runRoot = Split-Path -Parent $Manifest.paths.consumedMarker
    $auditRoot = $runRoot
    $auditPath = Join-Path $auditRoot 'bridge-diagnostics.tokens'
    if (-not [string]::Equals(
        (Split-Path -Parent $auditPath),
        $auditRoot,
        [StringComparison]::OrdinalIgnoreCase)) {
        throw 'bridge-diagnostic-audit'
    }
    $recoveryRoot = Join-Path $runRoot 'recovery'
    [string[]] $outputRoots = @(
        (Join-Path $Manifest.repository.root 'dist'),
        (Join-Path $Manifest.repository.root 'out')
    )
    $preserved = [ordered]@{
        dist = 'untouched'
        out = 'untouched'
        recoveryCreated = $false
        preservationComplete = $false
    }
    $certificate = [ordered]@{
        thumbprint = $null
        keyIdentifier = [string]$Manifest.certificate.keyContainerName
        pfxPath = [string]$Manifest.paths.pfx
        cerPath = [string]$Manifest.paths.cer
    }
    $publicationState = [ordered]@{
        stagingRoot = [string]$Manifest.paths.artifactRoot + '.staging'
        finalRoot = [string]$Manifest.paths.artifactRoot
        published = $false
        attempted = $false
    }
    $artifactManifestSha256 = ''
    $bridgeDiagnosticInvocationCount = 0
    $control = [ordered]@{
        cancellationToken = $CancellationToken
        deadlineUtc = $DeadlineUtc
    }
    $residue = [ordered]@{
        myCertificate = 0; rootTrust = 0; trustedPublisherTrust = 0; cngKey = 0
        pfx = 0; cer = 0; runtime = 0; process = 0; signingEnvironment = 0
        generatedDist = 0; generatedOut = 0; recoveryDirectory = 0
    }
    $currentPrimaryCategory = 'none'

    try {
        $currentPrimaryCategory = 'bridge-diagnostic-audit'
        [void](Assert-IntentArcBridgeDiagnosticAuditBoundary -AuditRoot $auditRoot -AuditPath $auditPath -RequireAbsent)
        Assert-IntentArcSignedReleaseContinuation -CancellationToken $CancellationToken -DeadlineUtc $DeadlineUtc
        $currentPrimaryCategory = 'output-preservation'
        [void](& $Operations['PreserveOutputRoot'] $outputRoots $recoveryRoot $preserved)
        Assert-IntentArcSignedReleaseContinuation -CancellationToken $CancellationToken -DeadlineUtc $DeadlineUtc
        if (-not (Test-IntentArcSignedReleaseRecord -Value $preserved -Keys @('dist', 'out', 'recoveryCreated', 'preservationComplete')) -or
            $preserved.dist -cnotin @('absent', 'preserved') -or
            $preserved.out -cnotin @('absent', 'preserved') -or
            $preserved.recoveryCreated -isnot [bool] -or
            $preserved.preservationComplete -isnot [bool] -or -not $preserved.preservationComplete) {
            throw 'output-preservation-invalid'
        }

        $currentPrimaryCategory = 'certificate-create'
        [void](& $Operations['PrepareCertificate'] $Manifest $certificate)
        Assert-IntentArcSignedReleaseContinuation -CancellationToken $CancellationToken -DeadlineUtc $DeadlineUtc
        if (-not (Test-IntentArcSignedReleaseRecord -Value $certificate -Keys @('thumbprint', 'keyIdentifier', 'pfxPath', 'cerPath')) -or
            $certificate.thumbprint -isnot [string] -or $certificate.thumbprint -cnotmatch '^[0-9A-F]{40}$' -or
            $certificate.keyIdentifier -isnot [string] -or $certificate.keyIdentifier -cnotmatch '^[A-Za-z0-9._-]{1,128}$' -or
            $certificate.pfxPath -isnot [string] -or -not [string]::Equals($certificate.pfxPath, [string]$Manifest.paths.pfx, [StringComparison]::OrdinalIgnoreCase) -or
            $certificate.cerPath -isnot [string] -or -not [string]::Equals($certificate.cerPath, [string]$Manifest.paths.cer, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'certificate-result-invalid'
        }
        $certificate.thumbprint = $certificate.thumbprint.ToUpperInvariant()

        foreach ($trustStore in $Manifest.certificate.trustStores) {
            $currentPrimaryCategory = if ([string]::Equals([string]$trustStore, 'Cert:\CurrentUser\TrustedPublisher', [StringComparison]::Ordinal)) { 'trusted-publisher-trust' } else { 'root-trust' }
            [void](& $Operations['AddTrust'] $certificate.thumbprint $trustStore)
            Assert-IntentArcSignedReleaseContinuation -CancellationToken $CancellationToken -DeadlineUtc $DeadlineUtc
        }
        $currentPrimaryCategory = 'trust-verification'
        $trustVerified = & $Operations['VerifyTrust'] $certificate.thumbprint $Manifest.certificate.trustStores
        Assert-IntentArcSignedReleaseContinuation -CancellationToken $CancellationToken -DeadlineUtc $DeadlineUtc
        if ($trustVerified -isnot [bool] -or -not $trustVerified) {
            throw 'trust-verification-failed'
        }
        $currentPrimaryCategory = 'signing-environment'
        [void](& $Operations['SetSigningEnvironment'] $Manifest $certificate)
        Assert-IntentArcSignedReleaseContinuation -CancellationToken $CancellationToken -DeadlineUtc $DeadlineUtc
        $highestCompletedState = 'prepared'

        $currentPrimaryCategory = 'release'
        $releaseInvocations++
        $release = & $Operations['InvokeRelease'] $Manifest $control
        Assert-IntentArcSignedReleaseContinuation -CancellationToken $CancellationToken -DeadlineUtc $DeadlineUtc
        $releaseKeys = @('releaseInvocations', 'nestedMakeInvocations', 'forbiddenLifecycleCount', 'externalPublicationCount')
        $releaseResultValid = Test-IntentArcSignedReleaseRecord -Value $release -Keys $releaseKeys
        if ($releaseResultValid) {
            foreach ($key in $releaseKeys) {
                if ($release[$key] -isnot [int]) {
                    $releaseResultValid = $false
                    break
                }
            }
        }
        if ($releaseResultValid) {
            $controllerState.externalPublicationInvocationCount = $release.externalPublicationCount
            $releaseResultValid = (
                $release.releaseInvocations -in @(0, 1) -and
                $release.nestedMakeInvocations -in @(0, 1) -and
                $release.forbiddenLifecycleCount -eq 0 -and
                $release.externalPublicationCount -eq 0 -and
                $release.releaseInvocations -eq $releaseInvocations -and
                $release.releaseInvocations -eq $Manifest.release.maximumReleaseInvocations -and
                $release.nestedMakeInvocations -eq $Manifest.release.maximumNestedMakeInvocations
            )
        }
        if (-not $releaseResultValid) {
            $primaryCategory = 'release-result-invalid'
        } else {
            $nestedMakeInvocations = $release.nestedMakeInvocations
            $forbiddenLifecycleCount = $release.forbiddenLifecycleCount
            $highestCompletedState = 'released'

            $currentPrimaryCategory = 'descendant-settlement'
            $preVerificationSettlement = & $Operations['SettleDescendants'] $Manifest $control
            if (-not (Test-IntentArcSignedReleaseRecord -Value $preVerificationSettlement -Keys @('processCount')) -or
                $preVerificationSettlement.processCount -isnot [int] -or $preVerificationSettlement.processCount -ne 0) {
                throw 'descendant-settlement'
            }
            Assert-IntentArcSignedReleaseContinuation -CancellationToken $CancellationToken -DeadlineUtc $DeadlineUtc

            $currentPrimaryCategory = 'signature-verification'
            $verification = & $Operations['VerifyRelease'] $Manifest $certificate.thumbprint
            Assert-IntentArcSignedReleaseContinuation -CancellationToken $CancellationToken -DeadlineUtc $DeadlineUtc
            $verificationKeys = @('signatureVerified')
            if (-not (Test-IntentArcSignedReleaseRecord -Value $verification -Keys $verificationKeys)) {
                throw 'release-verification-invalid'
            }
            foreach ($verificationKey in $verificationKeys) {
                if ($verification[$verificationKey] -isnot [bool] -or -not $verification[$verificationKey]) {
                    $currentPrimaryCategory = 'signature-verification'
                    throw 'release-verification-invalid'
                }
            }

            $currentPrimaryCategory = 'closed-bundle-publication'
            $publicationState.attempted = $true
            Assert-IntentArcSignedReleaseContinuation -CancellationToken $CancellationToken -DeadlineUtc $DeadlineUtc
            $bundle = & $Operations['PublishClosedArtifactBundle'] $Manifest $certificate.thumbprint $publicationState $control
            $bundleKeys = @('published', 'artifactManifestSha256', 'signatureVerified', 'bridgePredecessorVerified', 'artifactVerified', 'bridgeDiagnosticInvocationCount')
            if (-not (Test-IntentArcSignedReleaseRecord -Value $bundle -Keys $bundleKeys) -or $bundle.published -isnot [bool] -or -not $bundle.published -or $bundle.artifactManifestSha256 -isnot [string] -or $bundle.artifactManifestSha256 -cnotmatch '^[0-9a-f]{64}$' -or
                $bundle.bridgeDiagnosticInvocationCount -isnot [int] -or $bundle.bridgeDiagnosticInvocationCount -notin @(0, 5)) {
                throw 'artifact-bundle-failed'
            }
            foreach ($claimName in @('signatureVerified', 'bridgePredecessorVerified', 'artifactVerified')) {
                if ($bundle[$claimName] -isnot [bool] -or -not $bundle[$claimName]) {
                    $currentPrimaryCategory = switch ($claimName) {
                        'signatureVerified' { 'signature-verification' }
                        'bridgePredecessorVerified' { 'bridge-predecessor-verification' }
                        default { 'artifact-verification' }
                    }
                    throw 'artifact-bundle-failed'
                }
            }
            if ($bundle.bridgeDiagnosticInvocationCount -ne 5) {
                $currentPrimaryCategory = 'bridge-diagnostic-audit'
                throw 'bridge-diagnostic-audit'
            }
            $bridgeDiagnosticInvocationCount = 5
            if ($publicationState.published -isnot [bool] -or -not $publicationState.published -or
                $publicationState.attempted -isnot [bool] -or -not $publicationState.attempted -or
                $publicationState.stagingRoot -isnot [string] -or
                -not [string]::Equals($publicationState.stagingRoot, ([string]$Manifest.paths.artifactRoot + '.staging'), [StringComparison]::OrdinalIgnoreCase) -or
                $publicationState.finalRoot -isnot [string] -or
                -not [string]::Equals($publicationState.finalRoot, [string]$Manifest.paths.artifactRoot, [StringComparison]::OrdinalIgnoreCase)) {
                throw 'artifact-bundle-failed'
            }
            $artifactManifestSha256 = $bundle.artifactManifestSha256
            $highestCompletedState = 'verified'
            Assert-IntentArcSignedReleaseContinuation -CancellationToken $CancellationToken -DeadlineUtc $DeadlineUtc
        }
    } catch {
        if ($primaryCategory -ceq 'none') {
            $primaryCategory = Resolve-IntentArcSignedReleasePrimaryCategory -DefaultCategory $currentPrimaryCategory -Failure $_
        }
    } finally {
        $settledValidator = {
            param($Value)
            return (Test-IntentArcSignedReleaseRecord -Value $Value -Keys @('processCount')) -and $Value.processCount -is [int] -and $Value.processCount -eq 0
        }
        $cleanupControl = [pscustomobject]@{
            cancellationToken = [Threading.CancellationToken]::None
            deadlineUtc = [DateTime]::UtcNow.AddSeconds(5)
        }
        [void](Invoke-IntentArcSignedReleaseCleanupAttempt -Category 'descendant-settlement' -CleanupCategories $cleanupCategories -Operation $Operations['SettleDescendants'] -Arguments @($Manifest, $cleanupControl) -Validator $settledValidator)
        [void](Invoke-IntentArcSignedReleaseCleanupAttempt -Category 'signing-environment-clear' -CleanupCategories $cleanupCategories -Operation $Operations['ClearSigningEnvironment'])
        [void](Invoke-IntentArcSignedReleaseCleanupAttempt -Category 'root-trust-removal' -CleanupCategories $cleanupCategories -Operation $Operations['RemoveTrust'] -Arguments @($certificate.thumbprint, $Manifest.certificate.trustStores[0]))
        [void](Invoke-IntentArcSignedReleaseCleanupAttempt -Category 'trusted-publisher-trust-removal' -CleanupCategories $cleanupCategories -Operation $Operations['RemoveTrust'] -Arguments @($certificate.thumbprint, $Manifest.certificate.trustStores[1]))
        [void](Invoke-IntentArcSignedReleaseCleanupAttempt -Category 'my-certificate-removal' -CleanupCategories $cleanupCategories -Operation $Operations['RemoveCertificate'] -Arguments @($certificate.thumbprint, $Manifest.certificate.myStore))
        [void](Invoke-IntentArcSignedReleaseCleanupAttempt -Category 'cng-key-removal' -CleanupCategories $cleanupCategories -Operation $Operations['RemoveCngKey'] -Arguments @(,$certificate.keyIdentifier))
        [void](Invoke-IntentArcSignedReleaseCleanupAttempt -Category 'pfx-removal' -CleanupCategories $cleanupCategories -Operation $Operations['RemoveExactFile'] -Arguments @(,$certificate.pfxPath))
        [void](Invoke-IntentArcSignedReleaseCleanupAttempt -Category 'cer-removal' -CleanupCategories $cleanupCategories -Operation $Operations['RemoveExactFile'] -Arguments @(,$certificate.cerPath))
        [void](Invoke-IntentArcSignedReleaseCleanupAttempt -Category 'runtime-removal' -CleanupCategories $cleanupCategories -Operation $Operations['RemoveRuntime'] -Arguments @(,$Manifest.paths.runtime))
        if ($publicationState.attempted -and -not $publicationState.published) {
            [void](Invoke-IntentArcSignedReleaseCleanupAttempt -Category 'artifact-bundle-staging-rollback' -CleanupCategories $cleanupCategories -Operation $Operations['RemovePartialArtifactBundle'] -Arguments @($Manifest.paths.artifactRoot, $publicationState.stagingRoot))
            [void](Invoke-IntentArcSignedReleaseCleanupAttempt -Category 'artifact-bundle-final-rollback' -CleanupCategories $cleanupCategories -Operation $Operations['RemovePartialArtifactBundle'] -Arguments @($Manifest.paths.artifactRoot, $publicationState.finalRoot))
        }
        if ($preserved.preservationComplete -and $preserved.dist -cne 'untouched') {
            [void](Invoke-IntentArcSignedReleaseCleanupAttempt -Category 'generated-dist-removal' -CleanupCategories $cleanupCategories -Operation $Operations['RemoveGeneratedOutput'] -Arguments @($Manifest.repository.root, $outputRoots[0]))
        }
        if ($preserved.preservationComplete -and $preserved.out -cne 'untouched') {
            [void](Invoke-IntentArcSignedReleaseCleanupAttempt -Category 'generated-out-removal' -CleanupCategories $cleanupCategories -Operation $Operations['RemoveGeneratedOutput'] -Arguments @($Manifest.repository.root, $outputRoots[1]))
        }
        $restoreValidator = {
            param($Value)
            return (Test-IntentArcSignedReleaseRecord -Value $Value -Keys @('restored')) -and $Value.restored -is [bool] -and $Value.restored
        }
        [void](Invoke-IntentArcSignedReleaseCleanupAttempt -Category 'output-restoration' -CleanupCategories $cleanupCategories -Operation $Operations['RestoreOutputRoot'] -Arguments @($Manifest.repository.root, $recoveryRoot, $preserved) -Validator $restoreValidator)

        $afterValidator = {
            param($Value)
            return (Test-IntentArcSignedReleaseRecord -Value $Value -Keys @('storeProjectionRestored', 'outputProjectionRestored', 'artifactPublicationClean', 'residue')) -and
                $Value.storeProjectionRestored -is [bool] -and $Value.storeProjectionRestored -and
                $Value.outputProjectionRestored -is [bool] -and $Value.outputProjectionRestored -and
                $Value.artifactPublicationClean -is [bool] -and $Value.artifactPublicationClean
        }
        $after = Invoke-IntentArcSignedReleaseCleanupAttempt -Category 'after-projection' -CleanupCategories $cleanupCategories -Operation $Operations['GetAfterProjection'] -Arguments @($Manifest, $before) -Validator $afterValidator
        if ($null -ne $after) {
            try {
                $residue = New-IntentArcBoundedResidueSummary -Counts $after.residue
                foreach ($count in $residue.Values) {
                    if ($count -ne 0) {
                        [void]$cleanupCategories.Add('residue-proof')
                        break
                    }
                }
                $highestCompletedState = 'cleaned'
            } catch {
                [void]$cleanupCategories.Add('after-projection')
            }
        }
    }

    $manifestMatch = [Regex]::Match($ActualInvocation, ' -ExpectedAuthorizationSha256 ([0-9a-f]{64})$')
    $status = if ($primaryCategory -ceq 'none' -and $cleanupCategories.Count -eq 0 -and $bridgeDiagnosticInvocationCount -eq 5 -and $controllerState.externalPublicationInvocationCount -eq 0) { 'PASS' } else { 'FAIL' }
    $result = [ordered]@{
        schema = 'intentarc.signed-release-receipt/v3'
        runId = [string]$Manifest.run.id
        commit = [string]$Manifest.repository.commit
        manifestSha256 = $manifestMatch.Groups[1].Value
        status = $status
        highestCompletedState = $highestCompletedState
        primaryCategory = $primaryCategory
        cleanupCategories = @($cleanupCategories.ToArray())
        releaseInvocationCount = $releaseInvocations
        nestedMakeInvocationCount = $nestedMakeInvocations
        forbiddenLifecycleInvocationCount = $forbiddenLifecycleCount
        externalPublicationInvocationCount = $controllerState.externalPublicationInvocationCount
        bridgeDiagnosticInvocationCount = $bridgeDiagnosticInvocationCount
        residue = $residue
        artifactManifestSha256 = $artifactManifestSha256
        startedAtUtc = $startedAtUtc
        completedAtUtc = [DateTime]::UtcNow.ToString('o')
    }
    try {
        [void](& $Operations['WriteReceiptAtomic'] $Manifest.paths.receipt $result)
    } catch {
        [Console]::Error.WriteLine('{"status":"FAIL","category":"receipt-writing"}')
        throw 'receipt-writing'
    }
    return $result
}

function Test-IntentArcSignedReleaseSourcePolicy {
    param([Parameter(Mandatory)][string] $Source)

    $tokens = $null
    $parseErrors = $null
    $ast = [Management.Automation.Language.Parser]::ParseInput($Source, [ref]$tokens, [ref]$parseErrors)
    $violations = New-Object Collections.ArrayList
    if (@($parseErrors).Count -ne 0) {
        [void]$violations.Add('source-parse')
    }

    $policyDefinitions = @($ast.FindAll({
        param($node)
        return $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
            [string]::Equals($node.Name, 'Test-IntentArcSignedReleaseSourcePolicy', [StringComparison]::OrdinalIgnoreCase)
    }, $true))
    $isPolicyNode = {
        param($node)
        foreach ($definition in $policyDefinitions) {
            if ($node.Extent.StartOffset -ge $definition.Extent.StartOffset -and $node.Extent.EndOffset -le $definition.Extent.EndOffset) {
                return $true
            }
        }
        return $false
    }.GetNewClosure()
    $addViolation = {
        param([string] $Category)
        if (-not $violations.Contains($Category)) {
            [void]$violations.Add($Category)
        }
    }.GetNewClosure()

    # Dormancy is a closed top-level grammar: exactly the two reviewed helper
    # imports, function declarations, and the final direct-entry gate.
    $topLevel = @($ast.EndBlock.Statements)
    $topLevelPipelines = @($topLevel | Where-Object { $_ -is [Management.Automation.Language.PipelineAst] })
    $topLevelOthers = @($topLevel | Where-Object {
        $_ -isnot [Management.Automation.Language.PipelineAst] -and
        $_ -isnot [Management.Automation.Language.FunctionDefinitionAst] -and
        $_ -isnot [Management.Automation.Language.IfStatementAst]
    })
    if ($topLevelPipelines.Count -ne 2 -or $topLevelOthers.Count -ne 0 -or
        @($topLevel | Where-Object { $_ -is [Management.Automation.Language.IfStatementAst] }).Count -ne 1) {
        & $addViolation 'source-time-effect'
    }
    $expectedImports = @(
        ". (Join-Path `$PSScriptRoot 'signed-release-once-manifest.ps1')",
        ". (Join-Path `$PSScriptRoot 'signed-release-once-residue.ps1')"
    )
    if ($topLevelPipelines.Count -eq 2) {
        for ($importIndex = 0; $importIndex -lt 2; $importIndex++) {
            if (-not [string]::Equals($topLevelPipelines[$importIndex].Extent.Text.Trim(), $expectedImports[$importIndex], [StringComparison]::Ordinal)) {
                & $addViolation 'source-time-effect'
            }
        }
    }

    $releaseReferences = @($ast.FindAll({
        param($node)
        return $node -is [Management.Automation.Language.IndexExpressionAst] -and
            $node.Target -is [Management.Automation.Language.VariableExpressionAst] -and
            [string]::Equals($node.Target.VariablePath.UserPath, 'Operations', [StringComparison]::OrdinalIgnoreCase) -and
            $node.Index -is [Management.Automation.Language.StringConstantExpressionAst] -and
            [string]::Equals($node.Index.Value, 'InvokeRelease', [StringComparison]::OrdinalIgnoreCase) -and
            $node.Parent -is [Management.Automation.Language.CommandAst]
    }, $true))
    if ($releaseReferences.Count -ne 1) {
        & $addViolation 'release-call-count'
    }
    $packageIsolationReferences = @($ast.FindAll({
        param($node)
        return $node -is [Management.Automation.Language.CommandAst] -and
            [string]::Equals($node.GetCommandName(), 'Test-IntentArcRepositoryPackageManagerIsolation', [StringComparison]::OrdinalIgnoreCase)
    }, $true))
    if ($packageIsolationReferences.Count -ne 2) { & $addViolation 'release-config-isolation' }

    $hasDesktopPrefix = $false
    $hasMakeSuffix = $false
    $hasExecutionPolicyKey = $false
    $hasBypassValue = $false
    foreach ($stringAst in @($ast.FindAll({
        param($node)
        return $node -is [Management.Automation.Language.StringConstantExpressionAst]
    }, $true))) {
        if (& $isPolicyNode $stringAst) { continue }
        $value = [string]$stringAst.Value
        if ($value -match '(?i)Cert:\\LocalMachine(?:\\|$)') {
            & $addViolation 'local-machine-store'
        }
        if ([string]::Equals($value, 'desktop:make', [StringComparison]::OrdinalIgnoreCase)) {
            & $addViolation 'direct-make'
        }
        if ([string]::Equals($value, 'desktop:', [StringComparison]::OrdinalIgnoreCase)) { $hasDesktopPrefix = $true }
        if ([string]::Equals($value, 'make', [StringComparison]::OrdinalIgnoreCase)) { $hasMakeSuffix = $true }
        if ([string]::Equals($value, 'ExecutionPolicy', [StringComparison]::OrdinalIgnoreCase)) { $hasExecutionPolicyKey = $true }
        if ([string]::Equals($value, 'Bypass', [StringComparison]::OrdinalIgnoreCase)) { $hasBypassValue = $true }
    }
    if ($hasDesktopPrefix -and $hasMakeSuffix) { & $addViolation 'direct-make' }
    if ($hasExecutionPolicyKey -and $hasBypassValue) { & $addViolation 'execution-policy-bypass' }

    $constantString = {
        param($node, $self)
        if ($node -is [Management.Automation.Language.StringConstantExpressionAst]) { return [string]$node.Value }
        if ($node -is [Management.Automation.Language.ParenExpressionAst]) { return & $self $node.Pipeline.GetPureExpression() $self }
        if ($node -is [Management.Automation.Language.BinaryExpressionAst] -and
            [string]::Equals([string]$node.Operator, 'Plus', [StringComparison]::OrdinalIgnoreCase)) {
            $left = & $self $node.Left $self
            $right = & $self $node.Right $self
            if ($null -ne $left -and $null -ne $right) { return ([string]$left + [string]$right) }
        }
        return $null
    }
    foreach ($binaryAst in @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.BinaryExpressionAst] }, $true))) {
        $folded = & $constantString $binaryAst $constantString
        if ($null -ne $folded -and [string]::Equals($folded, 'desktop:make', [StringComparison]::OrdinalIgnoreCase)) {
            & $addViolation 'direct-make'
        }
    }

    foreach ($typeAst in @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.TypeExpressionAst] }, $true))) {
        if ([string]$typeAst.TypeName.FullName -match '^(?i:System\.)?Net(?:\.|$)') { & $addViolation 'external-publication' }
    }

    $getNewObjectTypeName = {
        param($commandAst)
        for ($elementIndex = 1; $elementIndex -lt $commandAst.CommandElements.Count; $elementIndex++) {
            $element = $commandAst.CommandElements[$elementIndex]
            if ($element -is [Management.Automation.Language.StringConstantExpressionAst]) {
                return [string]$element.Value
            }
            if ($element -is [Management.Automation.Language.CommandParameterAst] -and
                [string]::Equals($element.ParameterName, 'TypeName', [StringComparison]::OrdinalIgnoreCase) -and
                $elementIndex + 1 -lt $commandAst.CommandElements.Count -and
                $commandAst.CommandElements[$elementIndex + 1] -is [Management.Automation.Language.StringConstantExpressionAst]) {
                return [string]$commandAst.CommandElements[$elementIndex + 1].Value
            }
        }
        return ''
    }

    $externalCommands = @(
        'Invoke-WebRequest', 'Invoke-RestMethod', 'Start-BitsTransfer',
        'curl', 'curl.exe', 'scp', 'scp.exe', 'iwr', 'irm', 'wget'
    )
    $loggingCommands = @(
        'Write-Host', 'Write-Output', 'Write-Verbose', 'Write-Debug',
        'Write-Information', 'Out-File', 'Add-Content', 'Set-Content'
    )
    $sensitivePattern = '(?i)(password|securestring|private.?key|key.?name|environment|stdout|stderr)'
    foreach ($commandAst in @($ast.FindAll({
        param($node)
        return $node -is [Management.Automation.Language.CommandAst]
    }, $true))) {
        $commandName = $commandAst.GetCommandName()
        $commandText = [string]$commandAst.Extent.Text
        if ($null -ne $commandName -and $commandName -in @(
            'Set-Variable', 'set', 'sv',
            'New-Variable', 'nv', 'Clear-Variable', 'clv', 'Remove-Variable', 'rv',
            'Copy-Item', 'copy', 'cp', 'cpi',
            'Move-Item', 'move', 'mv', 'mi', 'Rename-Item', 'ren', 'rni',
            'Set-Item', 'si', 'New-Item', 'ni', 'Clear-Item', 'cli',
            'Remove-Item', 'del', 'erase', 'rd', 'ri', 'rm', 'rmdir'
        )) {
            & $addViolation 'process-start-count'
        }
        if ([string]::Equals([string]$commandAst.InvocationOperator, 'Ampersand', [StringComparison]::OrdinalIgnoreCase) -and
            $commandAst.CommandElements.Count -gt 0 -and
            $commandAst.CommandElements[0] -is [Management.Automation.Language.StringConstantExpressionAst] -and
            [string]::Equals([string]$commandAst.CommandElements[0].Value, 'pnpm.exe', [StringComparison]::OrdinalIgnoreCase)) {
            & $addViolation 'direct-make'
        }
        if ($commandText -match '(?i)-ExecutionPolicy\s+(?:''|")?Bypass(?:''|")?(?:\s|$)') {
            & $addViolation 'execution-policy-bypass'
        }
        if ($null -ne $commandName -and $commandName -in $externalCommands) {
            & $addViolation 'external-publication'
        }
        if ($null -ne $commandName -and [string]::Equals($commandName, 'New-Object', [StringComparison]::OrdinalIgnoreCase) -and
            $commandAst.CommandElements.Count -gt 1) {
            $newObjectType = & $getNewObjectTypeName $commandAst
            if ($newObjectType -match '^(?i:(?:System\.)?Net)(?:\.|$)') { & $addViolation 'external-publication' }
        }
        if ($null -ne $commandName -and [string]::Equals($commandName, 'Get-Command', [StringComparison]::OrdinalIgnoreCase) -and
            $commandText -match '(?i)pnpm(?:\.exe)?') {
            & $addViolation 'ambient-executable'
        }
        if ($null -ne $commandName -and ($commandName -match '^(?i:Publish-|Upload-Release|New-GitHubRelease)$')) {
            & $addViolation 'external-publication'
        }
        if ($null -ne $commandName -and $commandName -in @('Remove-Item', 'Remove-ItemProperty', 'certutil', 'certutil.exe')) {
            & $addViolation 'wildcard-prefix-removal'
        }
        if ($null -ne $commandName -and [string]::Equals($commandName, 'Copy-Item', [StringComparison]::OrdinalIgnoreCase) -and
            $commandText -match '(?i)(?:^|\s)-Recurse(?:\s|$)') {
            & $addViolation 'recursive-tree-effect'
        }
        if ($null -ne $commandName -and $commandName -in $loggingCommands -and $commandText -match $sensitivePattern) {
            & $addViolation 'sensitive-logging'
        }
        if ($null -ne $commandName -and (
            $commandName -in @('Start-Process', 'Invoke-Item', 'ii') -or
            $commandName -match '(?i)(?:^|[\\/])(?:IntentArc(?: Bridge| Setup)?|Activate|Update|Upgrade|Rollback|Uninstall|Refresh|Download)\.exe$' -or
            ($commandName -notin @('Update-IntentArcRecordedProcessIdentities') -and
             $commandName -match '^(?i:Install-|Uninstall-|Update-|Upgrade-|Rollback-|Activate-|Refresh-|Download-)')
        )) {
            & $addViolation 'forbidden-lifecycle'
        }
    }

    $getOperationRole = {
        param($node)
        $current = $node
        while ($null -ne $current) {
            if ($current -is [Management.Automation.Language.AssignmentStatementAst] -and
                $current.Left -is [Management.Automation.Language.IndexExpressionAst] -and
                $current.Left.Target -is [Management.Automation.Language.VariableExpressionAst] -and
                [string]::Equals($current.Left.Target.VariablePath.UserPath, 'operations', [StringComparison]::OrdinalIgnoreCase) -and
                $current.Left.Index -is [Management.Automation.Language.StringConstantExpressionAst]) {
                return [string]$current.Left.Index.Value
            }
            if ($current -is [Management.Automation.Language.FunctionDefinitionAst] -and
                [string]::Equals($current.Name, 'Invoke-IntentArcRuntimeClosureHelper', [StringComparison]::OrdinalIgnoreCase)) {
                return 'GetRuntimeClosure'
            }
            if ($current -is [Management.Automation.Language.FunctionDefinitionAst] -and
                [string]::Equals($current.Name, 'Invoke-IntentArcBoundGit', [StringComparison]::OrdinalIgnoreCase)) {
                return 'BoundGit'
            }
            $current = $current.Parent
        }
        return ''
    }
    $getSafeUnqualifiedVariableName = {
        param($variableAst)
        if ($variableAst -isnot [Management.Automation.Language.VariableExpressionAst] -or
            -not $variableAst.VariablePath.IsUnqualified) {
            return ''
        }
        return [string]$variableAst.VariablePath.UserPath
    }
    $getVariableIdentityLeaf = {
        param($variableAst)
        if ($variableAst -isnot [Management.Automation.Language.VariableExpressionAst]) { return '' }
        $userPath = [string]$variableAst.VariablePath.UserPath
        $separator = $userPath.LastIndexOf(':')
        if ($separator -ge 0) { return $userPath.Substring($separator + 1) }
        return $userPath
    }
    $getAssignmentTargetVariables = {
        param($target, $self)
        if ($target -is [Management.Automation.Language.VariableExpressionAst]) {
            return ,$target
        }
        $children = @()
        if ($target -is [Management.Automation.Language.ParenExpressionAst]) {
            $pureExpression = $target.Pipeline.GetPureExpression()
            if ($null -ne $pureExpression) { $children = @($pureExpression) }
        } elseif ($target -is [Management.Automation.Language.ArrayLiteralAst]) {
            $children = @($target.Elements)
        } elseif ($target -is [Management.Automation.Language.ConvertExpressionAst] -or
            $target -is [Management.Automation.Language.AttributedExpressionAst]) {
            $children = @($target.Child)
        }
        $variables = New-Object Collections.ArrayList
        foreach ($child in $children) {
            foreach ($variable in @(& $self $child $self)) {
                [void]$variables.Add($variable)
            }
        }
        return @($variables.ToArray())
    }
    $getDirectAssignedVariable = {
        param($commandAst)
        if (-not [string]::Equals([string]$commandAst.InvocationOperator, 'Unknown', [StringComparison]::Ordinal) -or
            $commandAst.Parent -isnot [Management.Automation.Language.PipelineAst] -or
            $commandAst.Parent.PipelineElements.Count -ne 1 -or
            $commandAst.Parent.Parent -isnot [Management.Automation.Language.AssignmentStatementAst] -or
            $commandAst.Parent.Parent.Right -ne $commandAst.Parent -or
            $commandAst.Parent.Parent.Left -isnot [Management.Automation.Language.VariableExpressionAst]) {
            return ''
        }
        return & $getSafeUnqualifiedVariableName $commandAst.Parent.Parent.Left
    }.GetNewClosure()
    $approvedReceiversByRole = @{}
    $processConstructionCount = 0
    foreach ($commandAst in @($ast.FindAll({
        param($node)
        return $node -is [Management.Automation.Language.CommandAst] -and
            [string]::Equals($node.GetCommandName(), 'New-Object', [StringComparison]::OrdinalIgnoreCase) -and
            $node.CommandElements.Count -gt 1
    }, $true))) {
        $typeName = & $getNewObjectTypeName $commandAst
        if ($typeName.StartsWith('System.', [StringComparison]::OrdinalIgnoreCase)) { $typeName = $typeName.Substring(7) }
        if (-not [string]::Equals($typeName, 'Diagnostics.Process', [StringComparison]::OrdinalIgnoreCase)) { continue }
        $processConstructionCount++
        $variableName = & $getDirectAssignedVariable $commandAst
        $role = & $getOperationRole $commandAst
        if ([string]::IsNullOrEmpty($variableName) -or
            $role -notin @('InvokeRelease', 'PublishClosedArtifactBundle', 'GetRuntimeClosure', 'BoundGit') -or
            $approvedReceiversByRole.ContainsKey($role)) {
            & $addViolation 'process-start-count'
        } else {
            $approvedReceiversByRole[$role] = $variableName
        }
    }
    foreach ($variableAst in @($ast.FindAll({
        param($node)
        return $node -is [Management.Automation.Language.VariableExpressionAst] -and
            -not $node.VariablePath.IsUnqualified
    }, $true))) {
        $identityLeaf = & $getVariableIdentityLeaf $variableAst
        foreach ($approvedReceiver in $approvedReceiversByRole.Values) {
            if ([string]::Equals($identityLeaf, [string]$approvedReceiver, [StringComparison]::OrdinalIgnoreCase)) {
                & $addViolation 'process-start-count'
                break
            }
        }
    }
    $assignmentCountsByRoleVariable = @{}
    foreach ($assignmentAst in @($ast.FindAll({
        param($node)
        return $node -is [Management.Automation.Language.AssignmentStatementAst]
    }, $true))) {
        $assignmentRole = & $getOperationRole $assignmentAst
        if ($assignmentRole -notin @('InvokeRelease', 'PublishClosedArtifactBundle', 'GetRuntimeClosure', 'BoundGit')) { continue }
        foreach ($assignmentTarget in @(& $getAssignmentTargetVariables $assignmentAst.Left $getAssignmentTargetVariables)) {
            $assignmentVariable = & $getSafeUnqualifiedVariableName $assignmentTarget
            if ([string]::IsNullOrEmpty($assignmentVariable)) { continue }
            $assignmentKey = '{0}:{1}' -f $assignmentRole, $assignmentVariable.ToLowerInvariant()
            if (-not $assignmentCountsByRoleVariable.ContainsKey($assignmentKey)) { $assignmentCountsByRoleVariable[$assignmentKey] = 0 }
            $assignmentCountsByRoleVariable[$assignmentKey]++
        }
    }
    foreach ($role in @('InvokeRelease', 'PublishClosedArtifactBundle', 'GetRuntimeClosure', 'BoundGit')) {
        if (-not $approvedReceiversByRole.ContainsKey($role)) { continue }
        $assignmentKey = '{0}:{1}' -f $role, ([string]$approvedReceiversByRole[$role]).ToLowerInvariant()
        if (-not $assignmentCountsByRoleVariable.ContainsKey($assignmentKey) -or
            $assignmentCountsByRoleVariable[$assignmentKey] -ne 1) {
            & $addViolation 'process-start-count'
        }
    }
    $processStartsByRole = @{ InvokeRelease = 0; PublishClosedArtifactBundle = 0; GetRuntimeClosure = 0; BoundGit = 0 }
    foreach ($memberAst in @($ast.FindAll({
        param($node)
        return $node -is [Management.Automation.Language.MemberExpressionAst]
    }, $true))) {
        $memberName = if ($memberAst.Member -is [Management.Automation.Language.StringConstantExpressionAst]) {
            [string]$memberAst.Member.Value
        } else {
            ''
        }
        $memberText = [string]$memberAst.Extent.Text
        if ([string]::Equals($memberName, 'Start', [StringComparison]::OrdinalIgnoreCase) -and
            $memberAst -is [Management.Automation.Language.InvokeMemberExpressionAst]) {
            if ($memberAst.Static) {
                & $addViolation 'process-start-count'
            } elseif ($memberAst.Expression -is [Management.Automation.Language.VariableExpressionAst]) {
                $receiverName = & $getSafeUnqualifiedVariableName $memberAst.Expression
                $actualRole = & $getOperationRole $memberAst
                if ($approvedReceiversByRole.ContainsKey($actualRole) -and
                    [string]::Equals($receiverName, [string]$approvedReceiversByRole[$actualRole], [StringComparison]::OrdinalIgnoreCase)) {
                    $processStartsByRole[$actualRole]++
                } else {
                    & $addViolation 'process-start-count'
                }
            } else {
                & $addViolation 'process-start-count'
            }
        }
        if ($memberName -match '^(?i:Upload|UploadFile|UploadData|Download|DownloadFile|DownloadData)$' -or
            $memberText -match '(?i)(?:Net\.)?WebClient') {
            & $addViolation 'external-publication'
        }
        if ([string]::Equals($memberName, 'LocalMachine', [StringComparison]::OrdinalIgnoreCase) -and
            $memberText -match '(?i)StoreLocation') {
            & $addViolation 'local-machine-store'
        }
        if ([string]::Equals($memberName, 'WriteLine', [StringComparison]::OrdinalIgnoreCase) -and
            $memberText -match '(?i)Console' -and $memberText -match $sensitivePattern) {
            & $addViolation 'sensitive-logging'
        }
        if ([string]::Equals($memberName, 'WaitForExit', [StringComparison]::OrdinalIgnoreCase) -and
            $memberAst -is [Management.Automation.Language.InvokeMemberExpressionAst] -and
            ($null -eq $memberAst.Arguments -or $memberAst.Arguments.Count -eq 0)) {
            & $addViolation 'unbounded-wait'
        }
        if ($memberName -in @('ReadToEnd', 'ReadToEndAsync')) { & $addViolation 'unbounded-output' }
        if ([string]::Equals($memberName, 'Delete', [StringComparison]::OrdinalIgnoreCase) -and
            $memberAst -is [Management.Automation.Language.InvokeMemberExpressionAst] -and
            @($memberAst.Arguments).Count -eq 2 -and
            [string]::Equals([string]$memberAst.Arguments[1].Extent.Text, '$true', [StringComparison]::OrdinalIgnoreCase)) {
            & $addViolation 'recursive-tree-effect'
        }
    }
    if ($processConstructionCount -ne 4 -or
        $approvedReceiversByRole.Count -ne 4 -or
        $processStartsByRole.InvokeRelease -ne 1 -or $processStartsByRole.PublishClosedArtifactBundle -ne 1 -or $processStartsByRole.GetRuntimeClosure -ne 1 -or $processStartsByRole.BoundGit -ne 1) {
        & $addViolation 'process-start-count'
    }

    return [ordered]@{
        valid = ($violations.Count -eq 0)
        violations = @($violations.ToArray())
        reviewedProcessStarts = [ordered]@{
            InvokeRelease = $processStartsByRole.InvokeRelease
            PublishClosedArtifactBundle = $processStartsByRole.PublishClosedArtifactBundle
            GetRuntimeClosure = $processStartsByRole.GetRuntimeClosure
            BoundGit = $processStartsByRole.BoundGit
        }
    }
}

function Set-IntentArcMinimalChildEnvironment {
    param(
        [Parameter(Mandatory)] $StartInfo,
        [Parameter(Mandatory)][string[]] $ExecutableDirectories,
        [Parameter()][hashtable] $AdditionalVariables = @{},
        [Parameter()][ValidateSet('.COM;.EXE', '.COM;.EXE;.CMD')][string] $PathExt = '.COM;.EXE'
    )

    $windowsRoot = [IO.Directory]::GetParent([Environment]::SystemDirectory).FullName
    $temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $userProfile = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
    if ([string]::IsNullOrWhiteSpace($windowsRoot) -or -not [IO.Directory]::Exists($windowsRoot) -or
        [string]::IsNullOrWhiteSpace($temporaryRoot) -or -not [IO.Directory]::Exists($temporaryRoot) -or
        [string]::IsNullOrWhiteSpace($userProfile) -or -not [IO.Directory]::Exists($userProfile)) {
        throw 'child-environment-invalid'
    }
    $pathEntries = New-Object 'Collections.Generic.List[string]'
    foreach ($directory in @($ExecutableDirectories + [IO.Path]::Combine($windowsRoot, 'System32'))) {
        $canonical = [IO.Path]::GetFullPath($directory)
        if (-not [IO.Directory]::Exists($canonical)) { throw 'child-environment-invalid' }
        if (-not $pathEntries.Contains($canonical)) { $pathEntries.Add($canonical) }
    }
    $StartInfo.EnvironmentVariables.Clear()
    $StartInfo.EnvironmentVariables['SystemRoot'] = $windowsRoot
    $StartInfo.EnvironmentVariables['WINDIR'] = $windowsRoot
    $StartInfo.EnvironmentVariables['TEMP'] = $temporaryRoot
    $StartInfo.EnvironmentVariables['TMP'] = $temporaryRoot
    $StartInfo.EnvironmentVariables['USERPROFILE'] = $userProfile
    $StartInfo.EnvironmentVariables['PATH'] = [string]::Join(';', $pathEntries.ToArray())
    $StartInfo.EnvironmentVariables['PATHEXT'] = $PathExt
    foreach ($name in $AdditionalVariables.Keys) {
        $value = [string]$AdditionalVariables[$name]
        if ([string]::IsNullOrWhiteSpace($value) -or $value.IndexOf([char]0) -ge 0) { throw 'child-environment-invalid' }
        $StartInfo.EnvironmentVariables[[string]$name] = $value
    }
}

function New-IntentArcBoundGitProcessStartInfo {
    param(
        [Parameter(Mandatory)][string] $Executable,
        [Parameter(Mandatory)][string] $RepositoryRoot,
        [Parameter(Mandatory)][ValidateSet('status', 'commit', 'tracked')][string] $Command
    )

    try {
        $git = [IO.Path]::GetFullPath($Executable)
        $root = [IO.Path]::GetFullPath($RepositoryRoot)
        if (-not [string]::Equals([IO.Path]::GetFileName($git), 'git.exe', [StringComparison]::OrdinalIgnoreCase) -or
            -not [IO.File]::Exists($git) -or [IO.Directory]::Exists($git) -or
            -not [IO.Directory]::Exists($root) -or $git.Contains('"') -or $root.Contains('"')) {
            throw 'invalid'
        }
        Assert-IntentArcResiduePathComponents -CanonicalPath $git
        Assert-IntentArcResiduePathComponents -CanonicalPath $root
        $suffix = switch ($Command) {
            'status' { 'status --porcelain=v1 --untracked-files=no' }
            'commit' { 'rev-parse HEAD' }
            'tracked' { 'ls-files -z' }
        }
        $startInfo = New-Object Diagnostics.ProcessStartInfo
        $startInfo.FileName = $git
        $startInfo.Arguments = ('--no-optional-locks -c core.fsmonitor=false -c core.quotePath=false -C "' + $root + '" ' + $suffix)
        $startInfo.WorkingDirectory = $root
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true
        $startInfo.EnvironmentVariables.Clear()
        $windowsRoot = [IO.Directory]::GetParent([Environment]::SystemDirectory).FullName
        $temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar)
        foreach ($name in @('SystemRoot', 'WINDIR')) { $startInfo.EnvironmentVariables[$name] = $windowsRoot }
        foreach ($name in @('TEMP', 'TMP')) { $startInfo.EnvironmentVariables[$name] = $temporaryRoot }
        return $startInfo
    } catch {
        throw 'bound-git-invalid'
    }
}

function Stop-IntentArcBoundProcessTree {
    param(
        [Parameter(Mandatory)][Diagnostics.Process] $Process,
        [scriptblock] $Observe = {
            param($Control)
            Invoke-IntentArcBoundedPowerShellObservation -ScriptText 'Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId -OperationTimeoutSec 1 -ErrorAction Stop' -Control $Control
        }
    )

    $opened = New-Object 'Collections.Generic.List[object]'
    try {
        $rootId = $Process.Id
        $rootTicks = $Process.StartTime.ToUniversalTime().Ticks
        $identities = New-Object 'Collections.Generic.List[object]'
        $identities.Add([pscustomobject]@{ id = $rootId; ticks = $rootTicks; process = $Process })
        $identityIds = New-Object 'Collections.Generic.HashSet[int]'
        [void]$identityIds.Add($rootId)
        $collect = {
            param($ObservedRows)
            $rows = @($ObservedRows | Where-Object { [int]$_.ProcessId -gt 0 })
            if ($rows.Count -gt 4096) { throw 'invalid' }
            $known = New-Object 'Collections.Generic.HashSet[int]'
            [void]$known.Add($rootId)
            $ordered = New-Object 'Collections.Generic.List[int]'
            $advanced = $true
            while ($advanced) {
                $advanced = $false
                foreach ($row in $rows) {
                    $child = [int]$row.ProcessId
                    $parent = [int]$row.ParentProcessId
                    if ($child -le 0 -or $parent -lt 0) { throw 'invalid' }
                    if ($known.Contains($parent) -and $known.Add($child)) {
                        if ($known.Count -gt 256) { throw 'invalid' }
                        $ordered.Add($child)
                        $advanced = $true
                    }
                }
            }
            foreach ($processId in $ordered) {
                if ($identityIds.Contains($processId)) { continue }
                try {
                    $candidate = [Diagnostics.Process]::GetProcessById($processId)
                    $identities.Add([pscustomobject]@{ id = $processId; ticks = $candidate.StartTime.ToUniversalTime().Ticks; process = $candidate })
                    [void]$identityIds.Add($processId)
                    $opened.Add($candidate)
                } catch [ArgumentException] { } catch { throw 'invalid' }
            }
        }.GetNewClosure()
        $waitForIdentity = {
            param($Identity)
            $deadlineUtc = [DateTime]::UtcNow.AddSeconds(2)
            $active = $true
            while ($active -and [DateTime]::UtcNow -lt $deadlineUtc) {
                $active = $false
                try {
                    $candidate = [Diagnostics.Process]::GetProcessById($Identity.id)
                    try {
                        if (-not $candidate.HasExited -and $candidate.StartTime.ToUniversalTime().Ticks -eq $Identity.ticks) { $active = $true }
                    } finally { $candidate.Dispose() }
                } catch [ArgumentException] { }
                if ($active) { Start-Sleep -Milliseconds 10 }
            }
            if ($active) { throw 'invalid' }
        }

        $discoveryFailed = $false
        $control = [pscustomobject]@{ cancellationToken = [Threading.CancellationToken]::None; deadlineUtc = [DateTime]::UtcNow.AddSeconds(2) }
        try {
            $observedRows = @(& $Observe $control)
            & $collect $observedRows
        } catch {
            $discoveryFailed = $true
            try {
                if (-not $Process.HasExited) { $Process.Kill() }
                & $waitForIdentity $identities[0]
            } catch { throw 'invalid' }
            $retryControl = [pscustomobject]@{ cancellationToken = [Threading.CancellationToken]::None; deadlineUtc = [DateTime]::UtcNow.AddSeconds(2) }
            try {
                $retryRows = @(& $Observe $retryControl)
                & $collect $retryRows
            } catch { }
        }
        for ($index = $identities.Count - 1; $index -ge 0; $index--) {
            $candidate = $identities[$index].process
            if (-not $candidate.HasExited) { $candidate.Kill() }
        }
        foreach ($identity in $identities) { & $waitForIdentity $identity }
        if ($discoveryFailed) { throw 'invalid' }
    } catch {
        try {
            if (-not $Process.HasExited) { $Process.Kill() }
            $rootDeadlineUtc = [DateTime]::UtcNow.AddSeconds(2)
            while (-not $Process.HasExited -and [DateTime]::UtcNow -lt $rootDeadlineUtc) {
                Start-Sleep -Milliseconds 10
            }
            if (-not $Process.HasExited) { throw 'invalid' }
        } catch { throw 'bound-process-settlement' }
        throw 'bound-process-settlement'
    } finally {
        foreach ($candidate in $opened) { $candidate.Dispose() }
    }
}

function Invoke-IntentArcBoundGit {
    param(
        [Parameter(Mandatory)][string] $Executable,
        [Parameter(Mandatory)][string] $RepositoryRoot,
        [Parameter(Mandatory)][ValidateSet('status', 'commit', 'tracked')][string] $Command,
        [Parameter(Mandatory)][string] $ExpectedSha256
    )

    try {
        $gitRecord = Assert-IntentArcBoundFileHash -LiteralPath $Executable -ExpectedLeaf 'git.exe' -ExpectedSha256 $ExpectedSha256
        $startInfo = New-IntentArcBoundGitProcessStartInfo -Executable $Executable -RepositoryRoot $RepositoryRoot -Command $Command
        $process = New-Object Diagnostics.Process
        $process.StartInfo = $startInfo
        if (-not $process.Start()) { throw 'invalid' }
        $control = [pscustomobject]@{ cancellationToken = [Threading.CancellationToken]::None; deadlineUtc = [DateTime]::UtcNow.AddSeconds(10) }
        $output = Receive-IntentArcBoundedProcessOutput -StandardOutput $process.StandardOutput.BaseStream -StandardError $process.StandardError.BaseStream -Control $control -MaximumBytesPerStream 1048576
        if (-not $process.HasExited -or $process.ExitCode -ne 0 -or $output.stderrBytes -ne 0) { throw 'invalid' }
        Assert-IntentArcBoundFileHash -LiteralPath $Executable -ExpectedLeaf 'git.exe' -ExpectedSha256 $ExpectedSha256 -PreviousRecord $gitRecord | Out-Null
        return $output.stdout
    } catch {
        if ($null -ne $process) {
            try { Stop-IntentArcBoundProcessTree -Process $process } catch { throw 'bound-git-settlement' }
            try { Assert-IntentArcBoundFileHash -LiteralPath $Executable -ExpectedLeaf 'git.exe' -ExpectedSha256 $ExpectedSha256 -PreviousRecord $gitRecord } catch { throw 'bound-git-drift' }
        }
        throw 'bound-git-invalid'
    } finally {
        if ($null -ne $process) { $process.Dispose() }
    }
}

function Get-IntentArcRepositoryPackageBin {
    param([Parameter(Mandatory)][string] $RepositoryRoot)

    try {
        if (-not [IO.Path]::IsPathRooted($RepositoryRoot) -or -not [IO.Directory]::Exists($RepositoryRoot)) {
            throw 'invalid'
        }
        $canonicalRoot = [IO.Path]::GetFullPath($RepositoryRoot)
        Assert-IntentArcResiduePathComponents -CanonicalPath $canonicalRoot
        $expected = [IO.Path]::GetFullPath((Join-Path $canonicalRoot 'node_modules\.bin'))
        if (-not [IO.Directory]::Exists($expected) -or [IO.File]::Exists($expected)) { throw 'invalid' }
        $canonical = Get-IntentArcConfirmedExistingTarget -LiteralRoot $canonicalRoot -LiteralCandidate $expected
        if (-not [string]::Equals($canonical, $expected, [StringComparison]::OrdinalIgnoreCase)) { throw 'invalid' }
        return $canonical
    } catch {
        throw 'repository-package-bin-invalid'
    }
}

function Test-IntentArcRepositoryPackageManagerIsolation {
    param([Parameter(Mandatory)][string] $RepositoryRoot)
    if (-not [IO.Path]::IsPathRooted($RepositoryRoot) -or -not [IO.Directory]::Exists($RepositoryRoot)) { return $false }
    foreach ($leaf in @('.npmrc', '.pnpmfile.cjs', '.pnpmfile.mjs')) {
        $candidate = Join-Path $RepositoryRoot $leaf
        if ([IO.File]::Exists($candidate) -or [IO.Directory]::Exists($candidate)) { return $false }
    }
    return $true
}

function Initialize-IntentArcReleaseEnvironment {
    param(
        [Parameter(Mandatory)][string] $RunRoot,
        [Parameter(Mandatory)][string] $RuntimeRoot
    )
    if (-not [string]::Equals($RuntimeRoot, (Join-Path $RunRoot 'runtime'), [StringComparison]::OrdinalIgnoreCase) -or
        [IO.File]::Exists($RuntimeRoot) -or [IO.Directory]::Exists($RuntimeRoot)) { throw 'release-environment-invalid' }
    [void](Get-IntentArcConfirmedExistingTarget -LiteralRoot $RunRoot -LiteralCandidate $RunRoot)
    [IO.Directory]::CreateDirectory($RuntimeRoot) | Out-Null
    [void](Get-IntentArcConfirmedExistingTarget -LiteralRoot $RunRoot -LiteralCandidate $RuntimeRoot)
    foreach ($leaf in @('home', 'config')) {
        [IO.Directory]::CreateDirectory((Join-Path $RuntimeRoot $leaf)) | Out-Null
        [void](Get-IntentArcConfirmedExistingTarget -LiteralRoot $RuntimeRoot -LiteralCandidate (Join-Path $RuntimeRoot $leaf))
    }
    $emptyConfig = Join-Path $RuntimeRoot 'empty.npmrc'
    $stream = [IO.File]::Open($emptyConfig, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.Flush($true) } finally { $stream.Dispose() }
    [void](Get-IntentArcConfirmedExistingTarget -LiteralRoot $RuntimeRoot -LiteralCandidate $emptyConfig)
}

function Receive-IntentArcBoundedProcessOutput {
    param(
        [Parameter(Mandatory)][IO.Stream] $StandardOutput,
        [Parameter(Mandatory)][IO.Stream] $StandardError,
        [Parameter(Mandatory)] $Control,
        [ValidateRange(1, 1048576)][int] $MaximumBytesPerStream = 65536,
        [scriptblock] $BeginRead,
        [scriptblock] $Heartbeat
    )

    if ($null -eq $BeginRead) {
        $BeginRead = { param($Stream, $Buffer) $Stream.ReadAsync($Buffer, 0, $Buffer.Length) }
    }
    $capture = New-Object IO.MemoryStream
    $stderrAlgorithm = [Security.Cryptography.SHA256]::Create()
    try {
        $states = @(
            [pscustomobject]@{ stream = $StandardOutput; buffer = (New-Object byte[] 4096); task = $null; count = 0; done = $false; capture = $true },
            [pscustomobject]@{ stream = $StandardError; buffer = (New-Object byte[] 4096); task = $null; count = 0; done = $false; capture = $false }
        )
        foreach ($streamState in $states) {
            $streamState.task = & $BeginRead $streamState.stream $streamState.buffer
            if ($null -eq $streamState.task -or $streamState.task -isnot [Threading.Tasks.Task]) { throw 'process-output-read' }
        }
        $nextHeartbeatUtc = [DateTime]::MinValue
        while (@($states | Where-Object { -not $_.done }).Count -ne 0) {
            Assert-IntentArcSignedReleaseContinuation -CancellationToken $Control.cancellationToken -DeadlineUtc $Control.deadlineUtc
            if ($null -ne $Heartbeat -and [DateTime]::UtcNow -ge $nextHeartbeatUtc) {
                & $Heartbeat
                $nextHeartbeatUtc = [DateTime]::UtcNow.AddMilliseconds(250)
            }
            $progressed = $false
            foreach ($streamState in $states) {
                if ($streamState.done -or -not $streamState.task.IsCompleted) { continue }
                $progressed = $true
                if ($streamState.task.IsFaulted -or $streamState.task.IsCanceled) { throw 'process-output-read' }
                $read = [int]$streamState.task.Result
                if ($read -lt 0 -or $read -gt $streamState.buffer.Length) { throw 'process-output-read' }
                if ($read -eq 0) { $streamState.done = $true; continue }
                $streamState.count += $read
                if ($streamState.count -gt $MaximumBytesPerStream) { throw 'process-output-limit' }
                if ($streamState.capture) {
                    $capture.Write($streamState.buffer, 0, $read)
                } else {
                    [void]$stderrAlgorithm.TransformBlock($streamState.buffer, 0, $read, $streamState.buffer, 0)
                }
                $streamState.task = & $BeginRead $streamState.stream $streamState.buffer
                if ($null -eq $streamState.task -or $streamState.task -isnot [Threading.Tasks.Task]) { throw 'process-output-read' }
            }
            if (-not $progressed) { Start-Sleep -Milliseconds 10 }
        }
        [void]$stderrAlgorithm.TransformFinalBlock((New-Object byte[] 0), 0, 0)
        $stderrSha256 = ([BitConverter]::ToString($stderrAlgorithm.Hash)).Replace('-', '').ToLowerInvariant()
        $encoding = New-Object Text.UTF8Encoding -ArgumentList @($false, $true)
        return [ordered]@{
            stdout = $encoding.GetString($capture.ToArray())
            stdoutBytes = [int]$states[0].count
            stderrBytes = [int]$states[1].count
            stderrSha256 = $stderrSha256
        }
    } catch {
        if ($_.Exception.Message -in @('interruption', 'timeout', 'process-output-limit')) { throw }
        throw 'process-output-read'
    } finally {
        $capture.Dispose()
        $stderrAlgorithm.Dispose()
    }
}

function Receive-IntentArcVerifierOutputBoundary {
    param(
        [Parameter(Mandatory)][IO.Stream] $StandardOutput,
        [Parameter(Mandatory)][IO.Stream] $StandardError,
        [Parameter(Mandatory)] $Control,
        [Parameter(Mandatory)][scriptblock] $Kill,
        [scriptblock] $BeginRead,
        [scriptblock] $Heartbeat
    )
    try {
        return Receive-IntentArcBoundedProcessOutput -StandardOutput $StandardOutput -StandardError $StandardError -Control $Control -BeginRead $BeginRead -Heartbeat $Heartbeat
    } catch {
        $failure = $_.Exception.Message
        try { & $Kill } catch { throw 'artifact-verifier-settlement' }
        if ($failure -in @('interruption', 'timeout')) { throw $failure }
        throw 'artifact-verification'
    }
}

function Assert-IntentArcBridgeDiagnosticAuditBoundary {
    param(
        [Parameter(Mandatory)][string] $AuditRoot,
        [Parameter(Mandatory)][string] $AuditPath,
        [switch] $RequireAbsent
    )

    try {
        if (-not [IO.Path]::IsPathRooted($AuditRoot) -or
            -not [IO.Path]::IsPathRooted($AuditPath) -or
            $AuditRoot.Contains('"') -or $AuditPath.Contains('"')) {
            throw 'invalid'
        }
        $canonicalRoot = [IO.Path]::GetFullPath($AuditRoot).TrimEnd([char[]]@('\', '/'))
        $canonicalPath = [IO.Path]::GetFullPath($AuditPath)
        $expectedPath = Join-Path $canonicalRoot 'bridge-diagnostics.tokens'
        if (-not [string]::Equals($AuditRoot, $canonicalRoot, [StringComparison]::OrdinalIgnoreCase) -or
            -not [string]::Equals($AuditPath, $canonicalPath, [StringComparison]::OrdinalIgnoreCase) -or
            -not [string]::Equals($canonicalPath, $expectedPath, [StringComparison]::OrdinalIgnoreCase) -or
            -not [string]::Equals((Split-Path -Parent $canonicalPath), $canonicalRoot, [StringComparison]::OrdinalIgnoreCase) -or
            -not [IO.Directory]::Exists($canonicalRoot) -or [IO.File]::Exists($canonicalRoot)) {
            throw 'invalid'
        }
        Assert-IntentArcResiduePathComponents -CanonicalPath $canonicalRoot
        $confirmedRoot = Get-IntentArcConfirmedExistingTarget -LiteralRoot $canonicalRoot -LiteralCandidate $canonicalRoot
        if (-not [string]::Equals($confirmedRoot, $canonicalRoot, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'invalid'
        }
        $auditEntries = @([IO.Directory]::GetFileSystemEntries(
            $canonicalRoot,
            'bridge-diagnostics.tokens',
            [IO.SearchOption]::TopDirectoryOnly
        ))
        if ($auditEntries.Count -gt 1 -or
            ($auditEntries.Count -eq 1 -and -not [string]::Equals(
                [IO.Path]::GetFullPath([string]$auditEntries[0]),
                $canonicalPath,
                [StringComparison]::OrdinalIgnoreCase))) {
            throw 'invalid'
        }
        if ($RequireAbsent -and $auditEntries.Count -ne 0) { throw 'invalid' }
        Assert-IntentArcResiduePathComponents -CanonicalPath $canonicalPath
        if ($auditEntries.Count -eq 1) {
            if (-not [IO.File]::Exists($canonicalPath) -or [IO.Directory]::Exists($canonicalPath)) {
                throw 'invalid'
            }
            $confirmedPath = Get-IntentArcConfirmedExistingTarget -LiteralRoot $canonicalRoot -LiteralCandidate $canonicalPath
            if (-not [string]::Equals($confirmedPath, $canonicalPath, [StringComparison]::OrdinalIgnoreCase)) {
                throw 'invalid'
            }
        }
        return [ordered]@{ root = $canonicalRoot; path = $canonicalPath }
    } catch {
        throw 'bridge-diagnostic-audit'
    }
}

function New-IntentArcReleaseProcessStartInfo {
    param(
        [Parameter(Mandatory)][string] $Executable,
        [Parameter(Mandatory)][string] $NodeExecutable,
        [Parameter(Mandatory)][string] $SignToolPath,
        [Parameter(Mandatory)][string] $WorkingDirectory,
        [Parameter(Mandatory)][string] $RuntimeRoot,
        [Parameter(Mandatory)][string] $AuditRoot,
        [Parameter(Mandatory)][string] $AuditPath
    )

    try {
        if (-not [IO.Path]::IsPathRooted($Executable) -or
            -not [string]::Equals([IO.Path]::GetFileName($Executable), 'pnpm.exe', [StringComparison]::OrdinalIgnoreCase) -or
            -not [IO.File]::Exists($Executable) -or [IO.Directory]::Exists($Executable) -or
            -not [IO.Path]::IsPathRooted($NodeExecutable) -or
            -not [string]::Equals([IO.Path]::GetFileName($NodeExecutable), 'node.exe', [StringComparison]::OrdinalIgnoreCase) -or
            -not [IO.File]::Exists($NodeExecutable) -or [IO.Directory]::Exists($NodeExecutable) -or
            -not [IO.Path]::IsPathRooted($SignToolPath) -or
            -not [string]::Equals([IO.Path]::GetFileName($SignToolPath), 'signtool.exe', [StringComparison]::OrdinalIgnoreCase) -or
            -not [IO.File]::Exists($SignToolPath) -or [IO.Directory]::Exists($SignToolPath) -or
            -not [IO.Path]::IsPathRooted($WorkingDirectory) -or
            -not [IO.Directory]::Exists($WorkingDirectory) -or
            -not (Test-IntentArcRepositoryPackageManagerIsolation -RepositoryRoot $WorkingDirectory) -or
            -not [IO.Path]::IsPathRooted($RuntimeRoot) -or -not [IO.Directory]::Exists($RuntimeRoot) -or
            $Executable.Contains('"') -or $NodeExecutable.Contains('"') -or $SignToolPath.Contains('"') -or $WorkingDirectory.Contains('"') -or $RuntimeRoot.Contains('"')) {
            throw 'invalid'
        }
        [void](Assert-IntentArcBridgeDiagnosticAuditBoundary -AuditRoot $AuditRoot -AuditPath $AuditPath -RequireAbsent)
        foreach ($path in @($Executable, $NodeExecutable, $SignToolPath, $WorkingDirectory, $RuntimeRoot)) {
            Assert-IntentArcResiduePathComponents -CanonicalPath ([IO.Path]::GetFullPath($path))
        }
        $packageBin = Get-IntentArcRepositoryPackageBin -RepositoryRoot $WorkingDirectory
        $releaseExecutableDirectories = @(
            [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Executable)),
            [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($NodeExecutable)),
            $packageBin
        )
        $directoryIdentities = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
        foreach ($directory in @($releaseExecutableDirectories + [Environment]::SystemDirectory)) {
            if (-not $directoryIdentities.Add([IO.Path]::GetFullPath($directory))) { throw 'invalid' }
        }
        if ($directoryIdentities.Count -ne 4) { throw 'invalid' }
    } catch {
        if ($_.Exception.Message -ceq 'bridge-diagnostic-audit') { throw 'bridge-diagnostic-audit' }
        throw 'release-process-start-invalid'
    }
    $controlledHome = Join-Path $RuntimeRoot 'home'
    $controlledConfigRoot = Join-Path $RuntimeRoot 'config'
    $emptyConfig = Join-Path $RuntimeRoot 'empty.npmrc'
    foreach ($path in @($RuntimeRoot, $controlledHome, $controlledConfigRoot, $emptyConfig)) {
        if (-not ([IO.Directory]::Exists($path) -or [IO.File]::Exists($path))) { throw 'release-process-start-invalid' }
        [void](Get-IntentArcConfirmedExistingTarget -LiteralRoot $RuntimeRoot -LiteralCandidate $path)
    }
    if (-not [IO.File]::Exists($emptyConfig) -or [IO.Directory]::Exists($emptyConfig) -or (Get-Item -LiteralPath $emptyConfig -Force).Length -ne 0) {
        throw 'release-process-start-invalid'
    }
    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = [IO.Path]::GetFullPath($Executable)
    $startInfo.Arguments = 'desktop:release'
    $startInfo.WorkingDirectory = [IO.Path]::GetFullPath($WorkingDirectory)
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $signingVariables = @{}
    foreach ($name in @(
        'INTENTARC_WINDOWS_CERTIFICATE', 'INTENTARC_WINDOWS_CERTIFICATE_PASSWORD',
        'INTENTARC_WINDOWS_CERTIFICATE_THUMBPRINT', 'INTENTARC_BRIDGE_AUTHORIZED_PREDECESSOR'
    )) { $signingVariables[$name] = [Environment]::GetEnvironmentVariable($name, [EnvironmentVariableTarget]::Process) }
    $signingVariables['HOME'] = $controlledHome
    $signingVariables['USERPROFILE'] = $controlledHome
    $signingVariables['LOCALAPPDATA'] = $controlledConfigRoot
    $signingVariables['APPDATA'] = $controlledConfigRoot
    $signingVariables['XDG_CONFIG_HOME'] = $controlledConfigRoot
    $signingVariables['npm_config_userconfig'] = $emptyConfig
    $signingVariables['npm_config_globalconfig'] = $emptyConfig
    $signingVariables['INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_ROOT'] = $AuditRoot
    $signingVariables['INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_PATH'] = $AuditPath
    $signingVariables['WINDOWS_SIGNTOOL_PATH'] = [IO.Path]::GetFullPath($SignToolPath)
    Set-IntentArcMinimalChildEnvironment `
        -StartInfo $startInfo `
        -ExecutableDirectories $releaseExecutableDirectories `
        -AdditionalVariables $signingVariables `
        -PathExt '.COM;.EXE;.CMD'
    return $startInfo
}

function New-IntentArcVerifierProcessStartInfo {
    param(
        [Parameter(Mandatory)][string] $Executable,
        [Parameter(Mandatory)][string] $ScriptPath,
        [Parameter(Mandatory)][string] $BundleRoot,
        [Parameter(Mandatory)][string] $ExpectedThumbprint,
        [Parameter(Mandatory)][string] $WorkingDirectory,
        [Parameter(Mandatory)][string] $AuditRoot,
        [Parameter(Mandatory)][string] $AuditPath
    )

    if (-not [IO.Path]::IsPathRooted($Executable) -or
        -not [string]::Equals([IO.Path]::GetFileName($Executable), 'node.exe', [StringComparison]::OrdinalIgnoreCase) -or
        -not [IO.File]::Exists($Executable) -or
        -not [IO.Path]::IsPathRooted($ScriptPath) -or
        -not [string]::Equals([IO.Path]::GetFileName($ScriptPath), 'signed-artifact-bundle.mjs', [StringComparison]::OrdinalIgnoreCase) -or
        -not [IO.File]::Exists($ScriptPath) -or
        -not [IO.Path]::IsPathRooted($BundleRoot) -or -not [IO.Directory]::Exists($BundleRoot) -or
        -not [IO.Path]::IsPathRooted($WorkingDirectory) -or -not [IO.Directory]::Exists($WorkingDirectory) -or
        $ExpectedThumbprint -cnotmatch '^[0-9A-F]{40}$' -or
        $Executable.Contains('"') -or $ScriptPath.Contains('"') -or $BundleRoot.Contains('"') -or $WorkingDirectory.Contains('"')) {
        throw 'artifact-verifier-process-invalid'
    }
    try {
        foreach ($path in @($Executable, $ScriptPath, $BundleRoot, $WorkingDirectory)) {
            Assert-IntentArcResiduePathComponents -CanonicalPath ([IO.Path]::GetFullPath($path))
        }
        [void](Assert-IntentArcBridgeDiagnosticAuditBoundary -AuditRoot $AuditRoot -AuditPath $AuditPath)
    } catch {
        if ($_.Exception.Message -ceq 'bridge-diagnostic-audit') { throw 'bridge-diagnostic-audit' }
        throw 'artifact-verifier-process-invalid'
    }
    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = [IO.Path]::GetFullPath($Executable)
    $startInfo.Arguments = '"' + [IO.Path]::GetFullPath($ScriptPath) + '" verify --bundle "' + [IO.Path]::GetFullPath($BundleRoot) + '" --expected-thumbprint ' + $ExpectedThumbprint
    $startInfo.WorkingDirectory = [IO.Path]::GetFullPath($WorkingDirectory)
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $additionalVariables = @{
        INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_ROOT = $AuditRoot
        INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_PATH = $AuditPath
    }
    Set-IntentArcMinimalChildEnvironment `
        -StartInfo $startInfo `
        -ExecutableDirectories @([IO.Path]::GetDirectoryName($startInfo.FileName)) `
        -AdditionalVariables $additionalVariables
    return $startInfo
}

function ConvertFrom-IntentArcArtifactVerifierEvidence {
    param(
        [Parameter(Mandatory)][string] $Json,
        [Parameter(Mandatory)][string] $ExpectedBundleId,
        [Parameter(Mandatory)][string] $ExpectedCommit,
        [Parameter(Mandatory)][string] $ExpectedThumbprint,
        [Parameter(Mandatory)][string] $ExpectedVerifierSha256
    )

    try {
        if ([Text.Encoding]::UTF8.GetByteCount($Json) -gt 65536 -or
            $ExpectedBundleId -cnotmatch '^[a-z0-9]+(?:-[a-z0-9]+)*$' -or
            $ExpectedCommit -cnotmatch '^[0-9a-f]{40}$' -or
            $ExpectedThumbprint -cnotmatch '^[0-9A-F]{40}$' -or
            $ExpectedVerifierSha256 -cnotmatch '^[0-9a-f]{64}$') {
            throw 'invalid'
        }
        $document = $Json | ConvertFrom-Json -ErrorAction Stop
        $expectedKeys = @(
            'bridgeDiagnosticInvocationCount', 'bridgeNativeVerified', 'bundleClosureVerified', 'bundleId', 'fileCount',
            'packageVersion', 'publisher', 'releaseExecutablesVerified', 'schemaVersion',
            'sourceCommit', 'totalBytes', 'verifierSha256'
        )
        $actualKeys = @($document.PSObject.Properties.Name | Sort-Object)
        if ($actualKeys.Count -ne $expectedKeys.Count) { throw 'invalid' }
        for ($index = 0; $index -lt $expectedKeys.Count; $index++) {
            if (-not [string]::Equals($actualKeys[$index], $expectedKeys[$index], [StringComparison]::Ordinal)) { throw 'invalid' }
        }
        $publisherKeys = @('cerSha256', 'subject', 'thumbprint')
        $actualPublisherKeys = @($document.publisher.PSObject.Properties.Name | Sort-Object)
        if ($actualPublisherKeys.Count -ne $publisherKeys.Count) { throw 'invalid' }
        for ($index = 0; $index -lt $publisherKeys.Count; $index++) {
            if (-not [string]::Equals($actualPublisherKeys[$index], $publisherKeys[$index], [StringComparison]::Ordinal)) { throw 'invalid' }
        }
        if ($document.schemaVersion -isnot [int] -or $document.schemaVersion -ne 1 -or
            $document.bridgeDiagnosticInvocationCount -isnot [int] -or $document.bridgeDiagnosticInvocationCount -notin @(0, 5) -or
            $document.fileCount -isnot [int] -or $document.fileCount -lt 1 -or $document.fileCount -gt 64 -or
            (($document.totalBytes -isnot [long]) -and ($document.totalBytes -isnot [int])) -or
            [long]$document.totalBytes -lt 0 -or [long]$document.totalBytes -gt 4294967296 -or
            $document.packageVersion -isnot [string] -or $document.packageVersion -cnotmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$' -or
            $document.publisher.cerSha256 -isnot [string] -or $document.publisher.cerSha256 -cnotmatch '^[0-9a-f]{64}$' -or
            $document.publisher.subject -isnot [string] -or [string]::IsNullOrWhiteSpace($document.publisher.subject) -or
            -not [string]::Equals([string]$document.bundleId, $ExpectedBundleId, [StringComparison]::Ordinal) -or
            -not [string]::Equals([string]$document.sourceCommit, $ExpectedCommit, [StringComparison]::Ordinal) -or
            -not [string]::Equals([string]$document.publisher.thumbprint, $ExpectedThumbprint, [StringComparison]::Ordinal) -or
            -not [string]::Equals([string]$document.verifierSha256, $ExpectedVerifierSha256, [StringComparison]::Ordinal)) {
            throw 'invalid'
        }
        foreach ($claimName in @('bridgeNativeVerified', 'bundleClosureVerified', 'releaseExecutablesVerified')) {
            if ($document.$claimName -isnot [bool] -or $document.$claimName -ne $true) { throw 'invalid' }
        }
        return [ordered]@{
            signatureVerified = [bool]$document.releaseExecutablesVerified
            bridgePredecessorVerified = [bool]$document.bridgeNativeVerified
            artifactVerified = [bool]$document.bundleClosureVerified
            bridgeDiagnosticInvocationCount = [int]$document.bridgeDiagnosticInvocationCount
            fileCount = [int]$document.fileCount
            totalBytes = [long]$document.totalBytes
        }
    } catch {
        throw 'artifact-verifier-evidence-invalid'
    }
}

function New-IntentArcCertificatePreparationCommands {
    param(
        [Parameter(Mandatory)] $Manifest,
        [Parameter(Mandatory)] $PreparationState,
        [Parameter(Mandatory)] $OperationState,
        [Parameter(Mandatory)][hashtable] $InnerCommands,
        [Parameter(Mandatory)][string] $RunRoot,
        [scriptblock] $FindCreatedCertificate
    )

    $create = $InnerCommands['certificate-create']
    $open = $InnerCommands['private-key-open']
    $exportPfx = $InnerCommands['certificate-export']
    $exportCer = $InnerCommands['public-certificate-export']
    $verifyThumbprint = $InnerCommands['thumbprint-verify']
    foreach ($operation in @($create, $open, $exportPfx, $exportCer, $verifyThumbprint)) {
        if ($operation -isnot [scriptblock]) { throw 'certificate-create' }
    }
    if ($null -eq $FindCreatedCertificate) {
        $FindCreatedCertificate = {
            param($Subject, $LiteralStore, $KeyContainerName)
            if (-not [string]::Equals($LiteralStore, 'Cert:\CurrentUser\My', [StringComparison]::Ordinal)) { return @() }
            $store = New-Object Security.Cryptography.X509Certificates.X509Store -ArgumentList @('My', 'CurrentUser')
            try {
                $store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)
                return @($store.Certificates | Where-Object {
                    if (-not [string]::Equals($_.Subject, $Subject, [StringComparison]::Ordinal)) { return $false }
                    $rsa = Get-IntentArcRsaPrivateKey -Certificate $_
                    try {
                        return $rsa -is [Security.Cryptography.RSACng] -and
                            [string]::Equals($rsa.Key.KeyName, $KeyContainerName, [StringComparison]::Ordinal)
                    } finally { if ($null -ne $rsa) { $rsa.Dispose() } }
                })
            } finally { $store.Close(); $store.Dispose() }
        }
    }
    return @{
        'certificate-create' = {
            param($Subject, $CertStoreLocation, $KeyContainerName)
            if (-not [string]::Equals($KeyContainerName, $Manifest.certificate.keyContainerName, [StringComparison]::Ordinal)) { throw 'key invalid' }
            $OperationState.KeyIdentifier = $KeyContainerName
            $PreparationState.keyIdentifier = $KeyContainerName
            $creationState = [ordered]@{ certificate = $null; thumbprint = $null }
            try {
                $created = & $create $Subject $CertStoreLocation $KeyContainerName $creationState
            } catch {
                $createFailure = $_
                if ($null -eq $creationState.certificate) {
                    try {
                        $recovered = @(& $FindCreatedCertificate $Subject $CertStoreLocation $KeyContainerName)
                        if ($recovered.Count -eq 1 -and $recovered[0].Thumbprint -is [string] -and
                            $recovered[0].Thumbprint -cmatch '^[0-9A-Fa-f]{40}$') {
                            $creationState.certificate = $recovered[0]
                            $creationState.thumbprint = $recovered[0].Thumbprint
                        }
                    } catch { }
                }
                throw $createFailure
            } finally {
                if ($null -ne $creationState.certificate -and
                    $creationState.thumbprint -is [string] -and
                    $creationState.thumbprint -cmatch '^[0-9A-Fa-f]{40}$') {
                    $OperationState.Certificate = $creationState.certificate
                    $PreparationState.thumbprint = $creationState.thumbprint.ToUpperInvariant()
                }
            }
            if ($null -eq $created -or $created.Thumbprint -cnotmatch '^[0-9A-Fa-f]{40}$') { throw 'certificate invalid' }
            $OperationState.Certificate = $created
            $PreparationState.thumbprint = $created.Thumbprint.ToUpperInvariant()
            return $created
        }.GetNewClosure()
        'private-key-open' = {
            param($Certificate)
            [void](& $open $Certificate)
            $rsa = Get-IntentArcRsaPrivateKey -Certificate $Certificate
            try {
                if ($rsa -isnot [Security.Cryptography.RSACng] -or
                    -not [string]::Equals($rsa.Key.KeyName, $Manifest.certificate.keyContainerName, [StringComparison]::Ordinal)) {
                    throw 'key invalid'
                }
            } finally {
                if ($null -ne $rsa) { $rsa.Dispose() }
            }
            return $true
        }.GetNewClosure()
        'certificate-export' = {
            param($Certificate, $PfxPath, $Password)
            $OperationState.PfxPath = $PfxPath
            $PreparationState.pfxPath = $PfxPath
            [void](Get-IntentArcConfirmedExistingTarget -LiteralRoot $RunRoot -LiteralCandidate $RunRoot)
            [void](& $exportPfx $Certificate $PfxPath $Password)
            if (-not [IO.File]::Exists($PfxPath) -or [IO.Directory]::Exists($PfxPath)) { throw 'certificate export invalid' }
            [void](Get-IntentArcConfirmedExistingTarget -LiteralRoot $RunRoot -LiteralCandidate $PfxPath)
            return $true
        }.GetNewClosure()
        'public-certificate-export' = {
            param($Certificate, $PublicCertificatePath)
            $OperationState.CerPath = $PublicCertificatePath
            $PreparationState.cerPath = $PublicCertificatePath
            [void](Get-IntentArcConfirmedExistingTarget -LiteralRoot $RunRoot -LiteralCandidate $RunRoot)
            [void](& $exportCer $Certificate $PublicCertificatePath)
            if (-not [IO.File]::Exists($PublicCertificatePath) -or [IO.Directory]::Exists($PublicCertificatePath)) { throw 'certificate export invalid' }
            [void](Get-IntentArcConfirmedExistingTarget -LiteralRoot $RunRoot -LiteralCandidate $PublicCertificatePath)
            return $true
        }.GetNewClosure()
        'thumbprint-verify' = {
            param($Certificate, $PublicCertificatePath)
            return & $verifyThumbprint $Certificate $PublicCertificatePath
        }.GetNewClosure()
    }
}

function Add-IntentArcSignedReleaseOperationMetadata {
    param(
        [Parameter(Mandatory)][scriptblock] $Operation,
        [Parameter(Mandatory)] $Metadata
    )

    $Operation | Add-Member -MemberType NoteProperty -Name IntentArcMetadata -Value $Metadata
    return $Operation
}

function Get-IntentArcConfirmedExistingTarget {
    param(
        [Parameter(Mandatory)][string] $LiteralRoot,
        [Parameter(Mandatory)][string] $LiteralCandidate
    )

    $canonical = Get-IntentArcValidatedCleanupTarget -LiteralRoot $LiteralRoot -LiteralCandidate $LiteralCandidate
    if ((Confirm-IntentArcValidatedCleanupTarget -LiteralRoot $LiteralRoot -CanonicalTarget $canonical) -cne 'cleanup-target-contained') {
        throw 'cleanup-target-invalid'
    }
    return $canonical
}

function Copy-IntentArcExactTreeEntry {
    param(
        [Parameter(Mandatory)][string] $LiteralSourceRoot,
        [Parameter(Mandatory)][string] $LiteralSource,
        [Parameter(Mandatory)][string] $LiteralDestinationRoot,
        [Parameter(Mandatory)][string] $LiteralDestination
    )

    $canonicalSource = Get-IntentArcConfirmedExistingTarget -LiteralRoot $LiteralSourceRoot -LiteralCandidate $LiteralSource
    $sourceInformation = [IO.File]::GetAttributes($canonicalSource)
    if (($sourceInformation -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'exact-tree-reparse-point' }
    [void](Get-IntentArcConfirmedExistingTarget -LiteralRoot $LiteralDestinationRoot -LiteralCandidate (Split-Path -Parent $LiteralDestination))
    if ([IO.Directory]::Exists($canonicalSource)) {
        if ([IO.File]::Exists($LiteralDestination) -or [IO.Directory]::Exists($LiteralDestination)) { throw 'exact-tree-destination-exists' }
        [IO.Directory]::CreateDirectory($LiteralDestination) | Out-Null
        [void](Get-IntentArcConfirmedExistingTarget -LiteralRoot $LiteralDestinationRoot -LiteralCandidate $LiteralDestination)
        $names = [string[]]@(([IO.DirectoryInfo]::new($canonicalSource)).GetFileSystemInfos() | ForEach-Object { $_.Name })
        [Array]::Sort($names, [StringComparer]::Ordinal)
        foreach ($name in $names) {
            Copy-IntentArcExactTreeEntry `
                -LiteralSourceRoot $LiteralSourceRoot `
                -LiteralSource (Join-Path $canonicalSource $name) `
                -LiteralDestinationRoot $LiteralDestinationRoot `
                -LiteralDestination (Join-Path $LiteralDestination $name)
        }
    } elseif ([IO.File]::Exists($canonicalSource)) {
        if ([IO.File]::Exists($LiteralDestination) -or [IO.Directory]::Exists($LiteralDestination)) { throw 'exact-tree-destination-exists' }
        [IO.File]::Copy($canonicalSource, $LiteralDestination, $false)
        [void](Get-IntentArcConfirmedExistingTarget -LiteralRoot $LiteralDestinationRoot -LiteralCandidate $LiteralDestination)
    } else {
        throw 'exact-tree-source-invalid'
    }
}

function Copy-IntentArcExactTree {
    param(
        [Parameter(Mandatory)][string] $LiteralSourceRoot,
        [Parameter(Mandatory)][string] $LiteralSource,
        [Parameter(Mandatory)][string] $LiteralDestinationRoot,
        [Parameter(Mandatory)][string] $LiteralDestination
    )
    [void](Get-IntentArcConfirmedExistingTarget -LiteralRoot $LiteralSourceRoot -LiteralCandidate $LiteralSourceRoot)
    [void](Get-IntentArcConfirmedExistingTarget -LiteralRoot $LiteralDestinationRoot -LiteralCandidate $LiteralDestinationRoot)
    Copy-IntentArcExactTreeEntry @PSBoundParameters
}

function Remove-IntentArcExactTree {
    param(
        [Parameter(Mandatory)][string] $LiteralRoot,
        [Parameter(Mandatory)][string] $LiteralPath
    )

    $canonical = Get-IntentArcConfirmedExistingTarget -LiteralRoot $LiteralRoot -LiteralCandidate $LiteralPath
    $information = [IO.File]::GetAttributes($canonical)
    if (($information -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'exact-tree-reparse-point' }
    if ([IO.Directory]::Exists($canonical)) {
        $names = [string[]]@(([IO.DirectoryInfo]::new($canonical)).GetFileSystemInfos() | ForEach-Object { $_.Name })
        [Array]::Sort($names, [StringComparer]::Ordinal)
        foreach ($name in $names) {
            Remove-IntentArcExactTree -LiteralRoot $LiteralRoot -LiteralPath (Join-Path $canonical $name)
        }
        [void](Get-IntentArcConfirmedExistingTarget -LiteralRoot $LiteralRoot -LiteralCandidate $canonical)
        [IO.Directory]::Delete($canonical, $false)
    } elseif ([IO.File]::Exists($canonical)) {
        [void](Get-IntentArcConfirmedExistingTarget -LiteralRoot $LiteralRoot -LiteralCandidate $canonical)
        [IO.File]::Delete($canonical)
    } else {
        throw 'exact-tree-source-invalid'
    }
}

function Get-IntentArcExactTreeFiles {
    param(
        [Parameter(Mandatory)][string] $LiteralRoot,
        [Parameter(Mandatory)][string] $LiteralPath
    )
    $canonical = Get-IntentArcConfirmedExistingTarget -LiteralRoot $LiteralRoot -LiteralCandidate $LiteralPath
    $information = [IO.File]::GetAttributes($canonical)
    if (($information -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'exact-tree-reparse-point' }
    if ([IO.File]::Exists($canonical)) { return ,$canonical }
    if (-not [IO.Directory]::Exists($canonical)) { throw 'exact-tree-source-invalid' }
    $files = New-Object 'Collections.Generic.List[string]'
    $names = [string[]]@(([IO.DirectoryInfo]::new($canonical)).GetFileSystemInfos() | ForEach-Object { $_.Name })
    [Array]::Sort($names, [StringComparer]::Ordinal)
    foreach ($name in $names) {
        foreach ($file in @(Get-IntentArcExactTreeFiles -LiteralRoot $LiteralRoot -LiteralPath (Join-Path $canonical $name))) {
            $files.Add($file)
        }
    }
    return @($files.ToArray())
}

function Get-IntentArcBoundLocalFileSha256 {
    param(
        [Parameter(Mandatory)][string] $LiteralPath,
        [Parameter(Mandatory)][string] $ExpectedLeaf
    )

    try {
        if (-not (Test-IntentArcCleanupCandidateSyntax -LiteralPath $LiteralPath) -or
            -not [string]::Equals([IO.Path]::GetFileName($LiteralPath), $ExpectedLeaf, [StringComparison]::OrdinalIgnoreCase) -or
            -not [IO.File]::Exists($LiteralPath) -or [IO.Directory]::Exists($LiteralPath)) {
            throw 'invalid'
        }
        $canonical = [IO.Path]::GetFullPath($LiteralPath)
        if (([IO.File]::GetAttributes($canonical) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'invalid' }
        Assert-IntentArcResiduePathComponents -CanonicalPath $canonical
        return Get-IntentArcTrackedFileSha256 -LiteralPath $canonical -MaximumBytes 1073741824
    } catch {
        throw 'execution-input-binding'
    }
}

function Assert-IntentArcBoundFileHash {
    param(
        [Parameter(Mandatory)][string] $LiteralPath,
        [Parameter(Mandatory)][string] $ExpectedLeaf,
        [Parameter(Mandatory)][string] $ExpectedSha256,
        [Parameter()] $PreviousRecord
    )

    try {
        $canonical = [IO.Path]::GetFullPath($LiteralPath)
        $sha256 = Get-IntentArcBoundLocalFileSha256 -LiteralPath $canonical -ExpectedLeaf $ExpectedLeaf
        $info = Get-Item -LiteralPath $canonical -Force -ErrorAction Stop
        $record = [ordered]@{ path = $canonical; type = 'file'; reparse = $false; length = [long]$info.Length; creationTicks = $info.CreationTimeUtc.Ticks; lastWriteTicks = $info.LastWriteTimeUtc.Ticks; sha256 = $sha256 }
        if ($ExpectedSha256 -cnotmatch '^[0-9a-f]{64}$' -or -not [string]::Equals($sha256, $ExpectedSha256, [StringComparison]::Ordinal)) {
            throw 'invalid'
        }
        if ($null -ne $PreviousRecord) {
            foreach ($name in @('path','type','reparse','length','creationTicks','lastWriteTicks','sha256')) {
                if ($null -eq $PreviousRecord[$name] -or -not [object]::Equals($record[$name], $PreviousRecord[$name])) { throw 'invalid' }
            }
        }
        return $record
    } catch {
        throw 'execution-input-drift'
    }
}

function Assert-IntentArcReleaseExecutionInputs {
    param([Parameter(Mandatory)]$Manifest, [Parameter()]$PreviousRecords)

    $records = [ordered]@{}
    $records.pnpm = Assert-IntentArcBoundFileHash -LiteralPath $Manifest.release.executablePath -ExpectedLeaf 'pnpm.exe' -ExpectedSha256 $Manifest.release.executableSha256 -PreviousRecord $(if ($null -eq $PreviousRecords) { $null } else { $PreviousRecords.pnpm })
    $records.node = Assert-IntentArcBoundFileHash -LiteralPath $Manifest.release.verifierExecutablePath -ExpectedLeaf 'node.exe' -ExpectedSha256 $Manifest.release.verifierExecutableSha256 -PreviousRecord $(if ($null -eq $PreviousRecords) { $null } else { $PreviousRecords.node })
    $records.signTool = Assert-IntentArcBoundFileHash -LiteralPath $Manifest.release.signToolPath -ExpectedLeaf 'signtool.exe' -ExpectedSha256 $Manifest.release.signToolSha256 -PreviousRecord $(if ($null -eq $PreviousRecords) { $null } else { $PreviousRecords.signTool })
    return $records
}

function Get-IntentArcTrackedFileSha256 {
    param(
        [Parameter(Mandatory)][string] $LiteralPath,
        [Parameter(Mandatory)][ValidateRange(1, 1073741824)][long] $MaximumBytes,
        [ref] $ObservedBytes
    )

    try {
        # Phase 1's trusted, quiescent-host identity record is the canonical
        # ordinary path plus reparse/type, length, creation, and write times,
        # paired with the streamed SHA-256 below. It is drift detection, not a
        # native volume/file identifier or hostile-race guarantee.
        $canonical = [IO.Path]::GetFullPath($LiteralPath)
        if (-not [IO.File]::Exists($canonical) -or [IO.Directory]::Exists($canonical) -or
            (([IO.File]::GetAttributes($canonical) -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
            throw 'invalid'
        }
        Assert-IntentArcResiduePathComponents -CanonicalPath $canonical
        $before = Get-Item -LiteralPath $canonical -Force -ErrorAction Stop
        if ($before -isnot [IO.FileInfo] -or $before.Length -gt $MaximumBytes) { throw 'invalid' }
        $algorithm = [Security.Cryptography.SHA256]::Create()
        $stream = $null
        try {
            $stream = [IO.File]::Open($canonical, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
            $buffer = New-Object byte[] 65536
            [long]$total = 0
            while (($read = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                $total += $read
                if ($total -gt $MaximumBytes) { throw 'invalid' }
                [void]$algorithm.TransformBlock($buffer, 0, $read, $buffer, 0)
            }
            [void]$algorithm.TransformFinalBlock((New-Object byte[] 0), 0, 0)
            if ($total -ne $before.Length) { throw 'invalid' }
            $sha256 = ([BitConverter]::ToString($algorithm.Hash)).Replace('-', '').ToLowerInvariant()
        } finally {
            if ($null -ne $stream) { $stream.Dispose() }
            $algorithm.Dispose()
        }
        Assert-IntentArcResiduePathComponents -CanonicalPath $canonical
        $after = Get-Item -LiteralPath $canonical -Force -ErrorAction Stop
        if ($after -isnot [IO.FileInfo] -or $after.Length -ne $before.Length -or
            $after.CreationTimeUtc.Ticks -ne $before.CreationTimeUtc.Ticks -or
            $after.LastWriteTimeUtc.Ticks -ne $before.LastWriteTimeUtc.Ticks -or
            (([IO.File]::GetAttributes($canonical) -band [IO.FileAttributes]::ReparsePoint) -ne 0) -or $total -ne $after.Length) {
            throw 'invalid'
        }
        if ($null -ne $ObservedBytes) { $ObservedBytes.Value = $total }
        return $sha256
    } catch {
        throw 'tracked-file-hash'
    }
}

function Invoke-IntentArcRuntimeClosureHelper {
    param(
        [Parameter(Mandatory)] $Manifest,
        [Parameter(Mandatory)][string] $ExpectedHelperSha256,
        [Parameter()] $Control
    )

    $process = New-Object Diagnostics.Process
    $started = $false
    try {
        $node = [IO.Path]::GetFullPath([string]$Manifest.release.verifierExecutablePath)
        $helper = [IO.Path]::GetFullPath((Join-Path $Manifest.repository.root 'scripts\release-runtime-closure.mjs'))
        if (-not [IO.File]::Exists($node) -or -not [IO.File]::Exists($helper)) { throw 'invalid' }
        $nodeRecord = Assert-IntentArcBoundFileHash -LiteralPath $node -ExpectedLeaf 'node.exe' -ExpectedSha256 $Manifest.release.verifierExecutableSha256
        $helperRecord = Assert-IntentArcBoundFileHash -LiteralPath $helper -ExpectedLeaf 'release-runtime-closure.mjs' -ExpectedSha256 $ExpectedHelperSha256
        $startInfo = New-Object Diagnostics.ProcessStartInfo
        $startInfo.FileName = $node
        $startInfo.Arguments = ('"' + $helper + '" --repository-root "' + [IO.Path]::GetFullPath($Manifest.repository.root) + '" --json')
        $startInfo.WorkingDirectory = [IO.Path]::GetFullPath($Manifest.repository.root)
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true
        $startInfo.EnvironmentVariables.Clear()
        $windowsRoot = [IO.Directory]::GetParent([Environment]::SystemDirectory).FullName
        $temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar)
        foreach ($name in @('SystemRoot', 'WINDIR')) { $startInfo.EnvironmentVariables[$name] = $windowsRoot }
        foreach ($name in @('TEMP', 'TMP')) { $startInfo.EnvironmentVariables[$name] = $temporaryRoot }
        $process.StartInfo = $startInfo
        if (-not $process.Start()) { throw 'invalid' }
        $started = $true
        $effectiveControl = if ($null -eq $Control) {
            [pscustomobject]@{ cancellationToken = [Threading.CancellationToken]::None; deadlineUtc = [DateTime]::UtcNow.AddSeconds(30) }
        } else {
            $Control
        }
        if ($null -eq $effectiveControl.cancellationToken -or $effectiveControl.deadlineUtc -isnot [DateTime]) { throw 'invalid' }
        $output = Receive-IntentArcBoundedProcessOutput -StandardOutput $process.StandardOutput.BaseStream -StandardError $process.StandardError.BaseStream -Control $effectiveControl
        if (-not $process.HasExited -or $process.ExitCode -ne 0 -or $output.stderrBytes -ne 0 -or $output.stdoutBytes -gt 4096) { throw 'invalid' }
        Assert-IntentArcBoundFileHash -LiteralPath $node -ExpectedLeaf 'node.exe' -ExpectedSha256 $Manifest.release.verifierExecutableSha256 -PreviousRecord $nodeRecord | Out-Null
        Assert-IntentArcBoundFileHash -LiteralPath $helper -ExpectedLeaf 'release-runtime-closure.mjs' -ExpectedSha256 $ExpectedHelperSha256 -PreviousRecord $helperRecord | Out-Null
        $document = $output.stdout | ConvertFrom-Json -ErrorAction Stop
        $keys = @($document.PSObject.Properties.Name | Sort-Object)
        $expected = @('fileCount', 'schema', 'sha256', 'totalBytes')
        if ($keys.Count -ne $expected.Count) { throw 'invalid' }
        for ($index = 0; $index -lt $expected.Count; $index++) { if (-not [string]::Equals($keys[$index], $expected[$index], [StringComparison]::Ordinal)) { throw 'invalid' } }
        if ($document.schema -cne 'intentarc.release-runtime-closure/v1' -or $document.sha256 -isnot [string] -or $document.sha256 -cnotmatch '^[0-9a-f]{64}$' -or
            $document.fileCount -isnot [int] -or $document.fileCount -lt 0 -or
            (($document.totalBytes -isnot [int]) -and ($document.totalBytes -isnot [long])) -or $document.totalBytes -lt 0) { throw 'invalid' }
        return [ordered]@{ sha256 = [string]$document.sha256; fileCount = [int]$document.fileCount; totalBytes = [long]$document.totalBytes }
    } catch {
        if ($started) {
            try { Stop-IntentArcBoundProcessTree -Process $process } catch { throw 'runtime-closure-settlement' }
            try {
                Assert-IntentArcBoundFileHash -LiteralPath $node -ExpectedLeaf 'node.exe' -ExpectedSha256 $Manifest.release.verifierExecutableSha256 -PreviousRecord $nodeRecord
                Assert-IntentArcBoundFileHash -LiteralPath $helper -ExpectedLeaf 'release-runtime-closure.mjs' -ExpectedSha256 $ExpectedHelperSha256 -PreviousRecord $helperRecord
            } catch { throw 'runtime-closure-drift' }
        }
        throw 'runtime-closure-invalid'
    } finally {
        $process.Dispose()
    }
}

function Get-IntentArcStoreParts {
    param([Parameter(Mandatory)][string] $LiteralStore)

    if ([string]::Equals($LiteralStore, 'Cert:\CurrentUser\My', [StringComparison]::Ordinal)) {
        return @([Security.Cryptography.X509Certificates.StoreName]::My, [Security.Cryptography.X509Certificates.StoreLocation]::CurrentUser)
    }
    if ([string]::Equals($LiteralStore, 'Cert:\CurrentUser\Root', [StringComparison]::Ordinal)) {
        return @([Security.Cryptography.X509Certificates.StoreName]::Root, [Security.Cryptography.X509Certificates.StoreLocation]::CurrentUser)
    }
    if ([string]::Equals($LiteralStore, 'Cert:\CurrentUser\TrustedPublisher', [StringComparison]::Ordinal)) {
        return @([Security.Cryptography.X509Certificates.StoreName]::TrustedPublisher, [Security.Cryptography.X509Certificates.StoreLocation]::CurrentUser)
    }
    throw 'certificate-store-invalid'
}

function Get-IntentArcExactCertificateCount {
    param(
        [Parameter(Mandatory)][string] $LiteralStore,
        [string] $Subject,
        [string] $Thumbprint
    )

    $parts = @(Get-IntentArcStoreParts -LiteralStore $LiteralStore)
    $store = New-Object Security.Cryptography.X509Certificates.X509Store -ArgumentList @($parts[0], $parts[1])
    try {
        $store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)
        $count = 0
        foreach ($certificate in $store.Certificates) {
            if (($null -ne $Subject -and [string]::Equals($certificate.Subject, $Subject, [StringComparison]::Ordinal)) -or
                ($null -ne $Thumbprint -and [string]::Equals($certificate.Thumbprint, $Thumbprint, [StringComparison]::OrdinalIgnoreCase))) {
                $count++
            }
        }
        return $count
    } finally {
        $store.Close()
        $store.Dispose()
    }
}

function Remove-IntentArcExactStoreCertificates {
    param(
        [AllowNull()][string] $Thumbprint,
        [Parameter(Mandatory)][string] $LiteralStore
    )

    if ($null -eq $Thumbprint) { return }
    if ($Thumbprint -cnotmatch '^[0-9A-F]{40}$') { throw 'certificate-identity-invalid' }
    $parts = @(Get-IntentArcStoreParts -LiteralStore $LiteralStore)
    $store = New-Object Security.Cryptography.X509Certificates.X509Store -ArgumentList @($parts[0], $parts[1])
    try {
        $store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
        $matches = @($store.Certificates | Where-Object {
            [string]::Equals($_.Thumbprint, $Thumbprint, [StringComparison]::OrdinalIgnoreCase)
        })
        foreach ($certificate in $matches) {
            try { $store.Remove($certificate) } finally { $certificate.Dispose() }
        }
    } finally {
        $store.Close()
        $store.Dispose()
    }
}

function Get-IntentArcRecordedCngKeyResidueCount {
    param(
        [AllowNull()][string] $KeyIdentifier,
        [scriptblock] $Exists
    )

    if ([string]::IsNullOrEmpty($KeyIdentifier)) {
        return 0
    }
    if ($KeyIdentifier -cnotmatch '^[A-Za-z0-9._-]{1,128}$') {
        throw 'cng-key-identity-invalid'
    }
    $present = if ($null -ne $Exists) {
        & $Exists $KeyIdentifier
    } else {
        [Security.Cryptography.CngKey]::Exists(
            $KeyIdentifier,
            [Security.Cryptography.CngProvider]::new('Microsoft Software Key Storage Provider')
        )
    }
    return [int][bool]$present
}

function Get-IntentArcActiveRecordedProcessCount {
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][int[]] $ProcessIds,
        [scriptblock] $IsActive
    )

    $unique = New-Object 'Collections.Generic.HashSet[int]'
    $count = 0
    foreach ($processId in $ProcessIds) {
        if ($processId -le 0 -or -not $unique.Add($processId)) { continue }
        $active = if ($null -ne $IsActive) {
            [bool](& $IsActive $processId)
        } else {
            try {
                $candidate = [Diagnostics.Process]::GetProcessById($processId)
                try { -not $candidate.HasExited } finally { $candidate.Dispose() }
            } catch [ArgumentException] {
                $false
            } catch {
                $true
            }
        }
        if ($active) { $count++ }
    }
    return $count
}

function Get-IntentArcActiveRecordedProcessIdentityCount {
    param(
        [Parameter(Mandatory)][hashtable] $ProcessIdentities,
        [scriptblock] $IsSameActiveProcess
    )
    $count = 0
    foreach ($key in @($ProcessIdentities.Keys)) {
        $processId = 0
        $startTicks = [long]0
        if (-not [int]::TryParse([string]$key, [ref]$processId) -or $processId -le 0 -or
            -not [long]::TryParse([string]$ProcessIdentities[$key], [ref]$startTicks) -or $startTicks -le 0) { throw 'process-identity-invalid' }
        $active = if ($null -ne $IsSameActiveProcess) {
            [bool](& $IsSameActiveProcess $processId $startTicks)
        } else {
            try {
                $candidate = [Diagnostics.Process]::GetProcessById($processId)
                try {
                    -not $candidate.HasExited -and $candidate.StartTime.ToUniversalTime().Ticks -eq $startTicks
                } finally { $candidate.Dispose() }
            } catch [ArgumentException] { $false } catch { $true }
        }
        if ($active) { $count++ }
    }
    return $count
}

function Invoke-IntentArcBoundedPowerShellObservation {
    param(
        [Parameter(Mandatory)][string] $ScriptText,
        [Parameter(Mandatory)] $Control,
        [ValidateRange(1, 5000)][int] $MaximumMilliseconds = 1500,
        [ValidateRange(2000, 5000)][int] $CleanupMilliseconds = 3500,
        [scriptblock] $PowerShellFactory
    )
    $powershell = if ($null -eq $PowerShellFactory) { [PowerShell]::Create() } else { & $PowerShellFactory }
    $completed = $false
    $started = $false
    $stopRequired = $false
    try {
        [void]$powershell.AddScript($ScriptText)
        $async = $powershell.BeginInvoke()
        $started = $true
        $localDeadline = [DateTime]::UtcNow.AddMilliseconds($MaximumMilliseconds)
        while (-not $async.IsCompleted) {
            try {
                Assert-IntentArcSignedReleaseContinuation -CancellationToken $Control.cancellationToken -DeadlineUtc $Control.deadlineUtc
            } catch {
                $stopRequired = $true
                throw
            }
            if ([DateTime]::UtcNow -ge $localDeadline) {
                $stopRequired = $true
                throw 'descendant-discovery'
            }
            Start-Sleep -Milliseconds 10
        }
        $completed = $true
        $result = @($powershell.EndInvoke($async))
        if ($powershell.HadErrors) { throw 'descendant-discovery' }
        return $result
    } finally {
        try {
            if ($stopRequired -and -not $completed) {
                $stopAsync = $powershell.BeginStop($null, $null)
                # The only production script has Get-CimInstance
                # -OperationTimeoutSec 1.  This independent ceiling leaves 2.5s
                # for PowerShell pipeline stop/EndStop/Dispose after that bound.
                $stopDeadline = [DateTime]::UtcNow.AddMilliseconds($CleanupMilliseconds)
                while (-not $stopAsync.IsCompleted -and [DateTime]::UtcNow -lt $stopDeadline) {
                    Start-Sleep -Milliseconds 10
                }
                if (-not $stopAsync.IsCompleted) { throw 'descendant-discovery-cleanup' }
                $completed = $true
                $powershell.EndStop($stopAsync)
            }
        } finally {
            if ($completed -or -not $started) { $powershell.Dispose() }
        }
    }
}

function Update-IntentArcRecordedProcessIdentities {
    param(
        [Parameter(Mandatory)][hashtable] $ProcessIdentities,
        [scriptblock] $Snapshot,
        [scriptblock] $GetStartTicks,
        $Control
    )
    if ($null -eq $Control) {
        $Control = [pscustomobject]@{ cancellationToken = [Threading.CancellationToken]::None; deadlineUtc = [DateTime]::UtcNow.AddSeconds(2) }
    }
    Assert-IntentArcSignedReleaseContinuation -CancellationToken $Control.cancellationToken -DeadlineUtc $Control.deadlineUtc
    $rows = @(if ($null -ne $Snapshot) {
        @(& $Snapshot)
    } else {
        @(Invoke-IntentArcBoundedPowerShellObservation -ScriptText 'Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId -OperationTimeoutSec 1 -ErrorAction Stop' -Control $Control)
    })
    if ($rows.Count -gt 4096 -or $ProcessIdentities.Count -gt 256) { throw 'descendant-discovery' }
    Assert-IntentArcSignedReleaseContinuation -CancellationToken $Control.cancellationToken -DeadlineUtc $Control.deadlineUtc
    $readTicks = if ($null -ne $GetStartTicks) {
        $GetStartTicks
    } else {
        {
            param($Id)
            $candidate = [Diagnostics.Process]::GetProcessById($Id)
            try { return $candidate.StartTime.ToUniversalTime().Ticks } finally { $candidate.Dispose() }
        }
    }
    $known = New-Object 'Collections.Generic.HashSet[int]'
    foreach ($key in @($ProcessIdentities.Keys)) {
        Assert-IntentArcSignedReleaseContinuation -CancellationToken $Control.cancellationToken -DeadlineUtc $Control.deadlineUtc
        $id = [int]$key
        $matches = @($rows | Where-Object { [int]$_.ProcessId -eq $id })
        if ($matches.Count -gt 1) { throw 'descendant-discovery' }
        if ($matches.Count -eq 0 -or [long](& $readTicks $id) -eq [long]$ProcessIdentities[$key]) {
            [void]$known.Add($id)
        }
    }
    $changed = $true
    while ($changed) {
        Assert-IntentArcSignedReleaseContinuation -CancellationToken $Control.cancellationToken -DeadlineUtc $Control.deadlineUtc
        $changed = $false
        foreach ($row in $rows) {
            Assert-IntentArcSignedReleaseContinuation -CancellationToken $Control.cancellationToken -DeadlineUtc $Control.deadlineUtc
            $childId = [int]$row.ProcessId
            if ($known.Contains([int]$row.ParentProcessId) -and -not $known.Contains($childId)) {
                $startTicks = [long](& $readTicks $childId)
                if ($startTicks -le 0) { throw 'descendant-discovery' }
                $ProcessIdentities[[string]$childId] = $startTicks
                if ($ProcessIdentities.Count -gt 256) { throw 'descendant-discovery' }
                [void]$known.Add($childId)
                $changed = $true
            }
        }
    }
}

function New-IntentArcSignedReleaseOperations {
    $scriptRoot = $PSScriptRoot
    $state = [pscustomobject]@{
        Manifest = $null
        Certificate = $null
        SecurePassword = $null
        PasswordValue = $null
        PfxPath = $null
        CerPath = $null
        KeyIdentifier = $null
        BeforeDist = $null
        BeforeOut = $null
        ReleaseProcess = $null
        ReleaseProcessIds = New-Object 'Collections.Generic.HashSet[int]'
        ReleaseProcessIdentities = @{}
        ReleaseExecutionInputRecords = $null
        TrackedFileBytes = [long]0
        Published = $false
    }

    $operations = @{}

    $operations['GetRepositoryState'] = Add-IntentArcSignedReleaseOperationMetadata -Operation ({
        param($Manifest)
        try {
            $git = [IO.Path]::GetFullPath([string]$Manifest.repository.gitExecutablePath)
            $status = Invoke-IntentArcBoundGit -Executable $git -RepositoryRoot $Manifest.repository.root -Command status -ExpectedSha256 $Manifest.repository.gitExecutableSha256
            $commit = Invoke-IntentArcBoundGit -Executable $git -RepositoryRoot $Manifest.repository.root -Command commit -ExpectedSha256 $Manifest.repository.gitExecutableSha256
            if ($commit -cnotmatch '^[0-9a-f]{40}\r?\n$') { throw 'invalid' }
            return [ordered]@{ clean = ([string]::IsNullOrEmpty($status)); commit = $commit.TrimEnd("`r", "`n") }
        } catch {
            throw 'repository-state-invalid'
        }
    }.GetNewClosure()) -Metadata ([ordered]@{ name = 'GetRepositoryState'; classification = 'observation' })

    $operations['GetFileHash'] = Add-IntentArcSignedReleaseOperationMetadata -Operation ({
        param($LiteralPath)
        [long]$bytes = 0
        $sha256 = Get-IntentArcTrackedFileSha256 -LiteralPath $LiteralPath -MaximumBytes 1073741824 -ObservedBytes ([ref]$bytes)
        if ($bytes -lt 0 -or $state.TrackedFileBytes -gt (8589934592 - $bytes)) { throw 'tracked-file-hash' }
        $state.TrackedFileBytes += $bytes
        return $sha256
    }.GetNewClosure()) -Metadata ([ordered]@{ name = 'GetFileHash'; classification = 'observation' })

    $operations['BindExecutionInputs'] = Add-IntentArcSignedReleaseOperationMetadata -Operation ({
        param($Manifest)
        $releaseSha256 = Get-IntentArcBoundLocalFileSha256 -LiteralPath $Manifest.release.executablePath -ExpectedLeaf 'pnpm.exe'
        $verifierExecutableSha256 = Get-IntentArcBoundLocalFileSha256 -LiteralPath $Manifest.release.verifierExecutablePath -ExpectedLeaf 'node.exe'
        $verifierScriptSha256 = Get-IntentArcBoundLocalFileSha256 -LiteralPath $Manifest.release.verifierScriptPath -ExpectedLeaf 'signed-artifact-bundle.mjs'
        $gitExecutableSha256 = Get-IntentArcBoundLocalFileSha256 -LiteralPath $Manifest.repository.gitExecutablePath -ExpectedLeaf 'git.exe'
        $signToolSha256 = Get-IntentArcBoundLocalFileSha256 -LiteralPath $Manifest.release.signToolPath -ExpectedLeaf 'signtool.exe'
        $runtimeHelperSha256 = Get-IntentArcBoundLocalFileSha256 -LiteralPath (Join-Path $Manifest.repository.root 'scripts\release-runtime-closure.mjs') -ExpectedLeaf 'release-runtime-closure.mjs'
        $commandLineProbeSha256 = Get-IntentArcBoundLocalFileSha256 -LiteralPath (Join-Path $Manifest.repository.root 'scripts\windows-commandline-probe.ps1') -ExpectedLeaf 'windows-commandline-probe.ps1'
        [void](Get-IntentArcRepositoryPackageBin -RepositoryRoot $Manifest.repository.root)
        $artifactParent = Split-Path -Parent $Manifest.paths.artifactRoot
        $expectedArtifactParent = Join-Path $Manifest.repository.root '.superpowers\artifacts'
        if (-not [string]::Equals($artifactParent, $expectedArtifactParent, [StringComparison]::OrdinalIgnoreCase) -or
            -not [IO.Directory]::Exists($artifactParent) -or [IO.File]::Exists($artifactParent)) {
            throw 'execution-input-binding'
        }
        if (-not (Test-IntentArcRepositoryPackageManagerIsolation -RepositoryRoot $Manifest.repository.root)) { throw 'execution-input-binding' }
        [void](Get-IntentArcConfirmedExistingTarget -LiteralRoot $artifactParent -LiteralCandidate $artifactParent)
        return [ordered]@{
            releaseExecutablePath = [IO.Path]::GetFullPath($Manifest.release.executablePath)
            releaseExecutableSha256 = $releaseSha256
            verifierExecutablePath = [IO.Path]::GetFullPath($Manifest.release.verifierExecutablePath)
            verifierExecutableSha256 = $verifierExecutableSha256
            verifierScriptPath = [IO.Path]::GetFullPath($Manifest.release.verifierScriptPath)
            verifierScriptSha256 = $verifierScriptSha256
            gitExecutablePath = [IO.Path]::GetFullPath($Manifest.repository.gitExecutablePath)
            gitExecutableSha256 = $gitExecutableSha256
            signToolPath = [IO.Path]::GetFullPath($Manifest.release.signToolPath)
            signToolSha256 = $signToolSha256
            runtimeHelperSha256 = $runtimeHelperSha256
            commandLineProbeSha256 = $commandLineProbeSha256
            artifactParentReady = $true
            packageBinReady = $true
        }
    }.GetNewClosure()) -Metadata ([ordered]@{ name = 'BindExecutionInputs'; classification = 'observation'; phase = 'pre-marker' })

    $operations['GetTrackedFileInventory'] = Add-IntentArcSignedReleaseOperationMetadata -Operation ({
        param($Manifest)
        try {
            $git = [IO.Path]::GetFullPath([string]$Manifest.repository.gitExecutablePath)
            $raw = [string](Invoke-IntentArcBoundGit -Executable $git -RepositoryRoot $Manifest.repository.root -Command tracked -ExpectedSha256 $Manifest.repository.gitExecutableSha256)
            if (-not $raw.EndsWith([string][char]0)) { throw 'invalid' }
            $paths = New-Object Collections.Generic.List[string]
            $offset = 0
            while ($offset -lt $raw.Length) {
                $terminator = $raw.IndexOf([char]0, $offset)
                if ($terminator -lt 0) { throw 'invalid' }
                $relativePath = $raw.Substring($offset, $terminator - $offset)
                if ([string]::IsNullOrEmpty($relativePath) -or $relativePath.IndexOfAny([char[]]@([char]0, [char]10, [char]13)) -ge 0 -or [IO.Path]::IsPathRooted($relativePath)) { throw 'invalid' }
                $candidate = [IO.Path]::GetFullPath((Join-Path $Manifest.repository.root $relativePath))
                $prefix = [IO.Path]::GetFullPath($Manifest.repository.root).TrimEnd('\\') + '\\'
                if (-not $candidate.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'invalid' }
                $paths.Add($candidate)
                $offset = $terminator + 1
            }
            return @($paths.ToArray())
        } catch { throw 'tracked-file-inventory' }
    }.GetNewClosure()) -Metadata ([ordered]@{ name = 'GetTrackedFileInventory'; classification = 'observation'; source = 'bound-git-ls-files-z' })

    $operations['GetRuntimeClosure'] = Add-IntentArcSignedReleaseOperationMetadata -Operation ({
        param($Manifest)
        try {
            $helper = [IO.Path]::GetFullPath((Join-Path $Manifest.repository.root 'scripts\release-runtime-closure.mjs'))
            $entries = @($Manifest.files | Where-Object {
                $_.path -is [string] -and [string]::Equals([IO.Path]::GetFullPath([string]$_.path), $helper, [StringComparison]::Ordinal)
            })
            if ($entries.Count -ne 1 -or $entries[0].sha256 -isnot [string] -or $entries[0].sha256 -cnotmatch '^[0-9a-f]{64}$') { throw 'invalid' }
            return Invoke-IntentArcRuntimeClosureHelper -Manifest $Manifest -ExpectedHelperSha256 $entries[0].sha256
        } catch {
            throw 'runtime-closure-invalid'
        }
    }.GetNewClosure()) -Metadata ([ordered]@{ name = 'GetRuntimeClosure'; classification = 'observation'; environment = 'fixed-four-variable' })

    $operations['GetBeforeProjection'] = Add-IntentArcSignedReleaseOperationMetadata -Operation ({
        param($Manifest)
        $state.Manifest = $Manifest
        $state.KeyIdentifier = [string]$Manifest.certificate.keyContainerName
        $state.PfxPath = [string]$Manifest.paths.pfx
        $state.CerPath = [string]$Manifest.paths.cer
        $dist = Join-Path $Manifest.repository.root 'dist'
        $out = Join-Path $Manifest.repository.root 'out'
        $state.BeforeDist = Get-IntentArcResidueProjection -LiteralRoot $dist
        $state.BeforeOut = Get-IntentArcResidueProjection -LiteralRoot $out
        $environmentNames = @(
            'INTENTARC_WINDOWS_CERTIFICATE', 'INTENTARC_WINDOWS_CERTIFICATE_PASSWORD',
            'INTENTARC_WINDOWS_CERTIFICATE_THUMBPRINT', 'INTENTARC_BRIDGE_AUTHORIZED_PREDECESSOR'
        )
        $environmentCount = @($environmentNames | Where-Object {
            -not [string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable($_, [EnvironmentVariableTarget]::Process))
        }).Count
        return [ordered]@{
            outputProjectionValid = $true
            consumedMarker = [int]([IO.File]::Exists($Manifest.paths.consumedMarker))
            myCertificate = Get-IntentArcExactCertificateCount -LiteralStore $Manifest.certificate.myStore -Subject $Manifest.certificate.subject
            rootTrust = Get-IntentArcExactCertificateCount -LiteralStore $Manifest.certificate.trustStores[0] -Subject $Manifest.certificate.subject
            trustedPublisherTrust = Get-IntentArcExactCertificateCount -LiteralStore $Manifest.certificate.trustStores[1] -Subject $Manifest.certificate.subject
            cngKey = Get-IntentArcRecordedCngKeyResidueCount -KeyIdentifier $state.KeyIdentifier
            pfx = [int]([IO.File]::Exists($Manifest.paths.pfx) -or [IO.Directory]::Exists($Manifest.paths.pfx))
            cer = [int]([IO.File]::Exists($Manifest.paths.cer) -or [IO.Directory]::Exists($Manifest.paths.cer))
            runtime = [int]([IO.Directory]::Exists($Manifest.paths.runtime) -or [IO.File]::Exists($Manifest.paths.runtime))
            artifactRoot = [int]([IO.Directory]::Exists($Manifest.paths.artifactRoot) -or [IO.File]::Exists($Manifest.paths.artifactRoot) -or [IO.Directory]::Exists($Manifest.paths.artifactRoot + '.staging') -or [IO.File]::Exists($Manifest.paths.artifactRoot + '.staging'))
            signingEnvironment = [int]($environmentCount -ne 0)
        }
    }.GetNewClosure()) -Metadata ([ordered]@{ name = 'GetBeforeProjection'; classification = 'observation' })

    $operations['CreateConsumedMarkerAtomic'] = Add-IntentArcSignedReleaseOperationMetadata -Operation ({
        param($LiteralPath, $Marker)
        $parent = Split-Path -Parent $LiteralPath
        [void](Get-IntentArcConfirmedExistingTarget -LiteralRoot $parent -LiteralCandidate $parent)
        if ([IO.File]::Exists($LiteralPath) -or [IO.Directory]::Exists($LiteralPath)) { return $false }
        [void](Get-IntentArcConfirmedExistingTarget -LiteralRoot $parent -LiteralCandidate $parent)
        $stream = [IO.File]::Open($LiteralPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try {
            $bytes = [Text.UTF8Encoding]::new($false, $true).GetBytes(($Marker | ConvertTo-Json -Compress))
            $stream.Write($bytes, 0, $bytes.Length)
            $stream.Flush($true)
        } finally {
            $stream.Dispose()
        }
        return $true
    }.GetNewClosure()) -Metadata ([ordered]@{ name = 'CreateConsumedMarkerAtomic'; classification = 'mutation' })

    $operations['PreserveOutputRoot'] = Add-IntentArcSignedReleaseOperationMetadata -Operation ({
        param($OutputRoots, $RecoveryRoot, $PreservedState)
        $roots = @($OutputRoots)
        if ($roots.Count -ne 2 -or
            -not [string]::Equals($roots[0], (Join-Path $state.Manifest.repository.root 'dist'), [StringComparison]::OrdinalIgnoreCase) -or
            -not [string]::Equals($roots[1], (Join-Path $state.Manifest.repository.root 'out'), [StringComparison]::OrdinalIgnoreCase) -or
            -not [string]::Equals($RecoveryRoot, (Join-Path (Split-Path -Parent $state.Manifest.paths.consumedMarker) 'recovery'), [StringComparison]::OrdinalIgnoreCase)) {
            throw 'output-preservation-invalid'
        }
        $runRoot = Split-Path -Parent $state.Manifest.paths.consumedMarker
        if ([IO.Directory]::Exists($RecoveryRoot) -or [IO.File]::Exists($RecoveryRoot)) { throw 'output-preservation-invalid' }
        [void](Get-IntentArcConfirmedExistingTarget -LiteralRoot $runRoot -LiteralCandidate $runRoot)
        [IO.Directory]::CreateDirectory($RecoveryRoot) | Out-Null
        $PreservedState.recoveryCreated = $true
        foreach ($root in $roots) {
            $name = [IO.Path]::GetFileName($root)
            if (-not [IO.Directory]::Exists($root) -and -not [IO.File]::Exists($root)) {
                $PreservedState[$name] = 'absent'
                continue
            }
            if (-not [IO.Directory]::Exists($root)) { throw 'output-preservation-invalid' }
            $destination = Join-Path $RecoveryRoot $name
            if ([IO.Directory]::Exists($destination) -or [IO.File]::Exists($destination)) { throw 'output-preservation-invalid' }
            $PreservedState[$name] = 'moving'
            $canonicalSource = Get-IntentArcConfirmedExistingTarget -LiteralRoot $state.Manifest.repository.root -LiteralCandidate $root
            [void](Get-IntentArcConfirmedExistingTarget -LiteralRoot $runRoot -LiteralCandidate $RecoveryRoot)
            [IO.Directory]::Move($canonicalSource, $destination)
            $PreservedState[$name] = 'preserved'
        }
        $PreservedState.preservationComplete = $true
        return $PreservedState
    }.GetNewClosure()) -Metadata ([ordered]@{ name = 'PreserveOutputRoot'; classification = 'mutation' })

    $operations['PrepareCertificate'] = Add-IntentArcSignedReleaseOperationMetadata -Operation ({
        param($Manifest, $PreparationState)
        . (Join-Path $scriptRoot 'windows-signing-certificate.ps1')
        if (-not [string]::Equals($Manifest.certificate.myStore, 'Cert:\CurrentUser\My', [StringComparison]::Ordinal)) {
            throw 'certificate-create'
        }
        $runRoot = Split-Path -Parent $Manifest.paths.consumedMarker
        foreach ($path in @($Manifest.paths.pfx, $Manifest.paths.cer)) {
            if (-not (Test-IntentArcCleanupCandidateSyntax -LiteralPath $path) -or
                -not [string]::Equals((Split-Path -Parent $path), $runRoot, [StringComparison]::OrdinalIgnoreCase)) {
                throw 'certificate-create'
            }
        }
        Initialize-IntentArcReleaseEnvironment -RunRoot $runRoot -RuntimeRoot $Manifest.paths.runtime
        $state.PasswordValue = [Guid]::NewGuid().ToString('N') + [Guid]::NewGuid().ToString('N')
        $state.SecurePassword = ConvertTo-SecureString -String $state.PasswordValue -AsPlainText -Force
        $commands = Get-IntentArcSigningCertificateCommands
        $wrapped = New-IntentArcCertificatePreparationCommands -Manifest $Manifest -PreparationState $PreparationState -OperationState $state -InnerCommands $commands -RunRoot $runRoot
        $state.Certificate = New-IntentArcSigningCertificate `
            -Subject $Manifest.certificate.subject `
            -CertStoreLocation $Manifest.certificate.myStore `
            -KeyContainerName $Manifest.certificate.keyContainerName `
            -PfxPath $Manifest.paths.pfx `
            -PublicCertificatePath $Manifest.paths.cer `
            -Password $state.SecurePassword `
            -Commands $wrapped
        return $PreparationState
    }.GetNewClosure()) -Metadata ([ordered]@{
        name = 'PrepareCertificate'; classification = 'mutation'
        helper = 'New-IntentArcSigningCertificate'; myStore = 'Cert:\CurrentUser\My'; partialState = 'immediate'
    })

    $operations['AddTrust'] = Add-IntentArcSignedReleaseOperationMetadata -Operation ({
        param($Thumbprint, $TrustStore)
        if ($null -eq $state.Certificate -or
            -not [string]::Equals($state.Certificate.Thumbprint, $Thumbprint, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'trust-add-invalid'
        }
        $parts = @(Get-IntentArcStoreParts -LiteralStore $TrustStore)
        if ($TrustStore -notin @('Cert:\CurrentUser\Root', 'Cert:\CurrentUser\TrustedPublisher')) { throw 'trust-add-invalid' }
        $store = New-Object Security.Cryptography.X509Certificates.X509Store -ArgumentList @($parts[0], $parts[1])
        try {
            $store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
            $store.Add($state.Certificate)
        } finally {
            $store.Close(); $store.Dispose()
        }
    }.GetNewClosure()) -Metadata ([ordered]@{
        name = 'AddTrust'; classification = 'mutation'
        stores = @('Cert:\CurrentUser\Root', 'Cert:\CurrentUser\TrustedPublisher'); identity = 'exact-thumbprint'
    })

    $operations['VerifyTrust'] = Add-IntentArcSignedReleaseOperationMetadata -Operation ({
        param($Thumbprint, $TrustStores)
        foreach ($store in @($TrustStores)) {
            if ($store -notin @('Cert:\CurrentUser\Root', 'Cert:\CurrentUser\TrustedPublisher') -or
                (Get-IntentArcExactCertificateCount -LiteralStore $store -Thumbprint $Thumbprint) -ne 1) {
                return $false
            }
        }
        return $true
    }.GetNewClosure()) -Metadata ([ordered]@{ name = 'VerifyTrust'; classification = 'verification' })

    $operations['SetSigningEnvironment'] = Add-IntentArcSignedReleaseOperationMetadata -Operation ({
        param($Manifest, $Certificate)
        if ($null -eq $state.PasswordValue -or $null -eq $state.PfxPath) { throw 'signing-environment' }
        [Environment]::SetEnvironmentVariable('INTENTARC_WINDOWS_CERTIFICATE', $state.PfxPath, [EnvironmentVariableTarget]::Process)
        [Environment]::SetEnvironmentVariable('INTENTARC_WINDOWS_CERTIFICATE_PASSWORD', $state.PasswordValue, [EnvironmentVariableTarget]::Process)
        [Environment]::SetEnvironmentVariable('INTENTARC_WINDOWS_CERTIFICATE_THUMBPRINT', $Certificate.thumbprint, [EnvironmentVariableTarget]::Process)
        [Environment]::SetEnvironmentVariable('INTENTARC_BRIDGE_AUTHORIZED_PREDECESSOR', [string]$Manifest.release.bridgeAuthorizedPredecessor, [EnvironmentVariableTarget]::Process)
    }.GetNewClosure()) -Metadata ([ordered]@{ name = 'SetSigningEnvironment'; classification = 'mutation' })

    $operations['InvokeRelease'] = Add-IntentArcSignedReleaseOperationMetadata -Operation ({
        param($Manifest, $Control)
        $auditRoot = Split-Path -Parent $Manifest.paths.consumedMarker
        $auditPath = Join-Path $auditRoot 'bridge-diagnostics.tokens'
        $releaseInputRecords = Assert-IntentArcReleaseExecutionInputs -Manifest $Manifest
        $state.ReleaseExecutionInputRecords = $releaseInputRecords
        $startInfo = New-IntentArcReleaseProcessStartInfo `
            -Executable $Manifest.release.executablePath `
            -NodeExecutable $Manifest.release.verifierExecutablePath `
            -SignToolPath $Manifest.release.signToolPath `
            -WorkingDirectory $Manifest.repository.root `
            -RuntimeRoot $Manifest.paths.runtime `
            -AuditRoot $auditRoot `
            -AuditPath $auditPath
        $process = New-Object Diagnostics.Process
        $process.StartInfo = $startInfo
        if (-not $process.Start()) { throw 'release' }
        $state.ReleaseProcess = $process
        [void]$state.ReleaseProcessIds.Add($process.Id)
        $state.ReleaseProcessIdentities[[string]$process.Id] = $process.StartTime.ToUniversalTime().Ticks
        $discover = { Update-IntentArcRecordedProcessIdentities -ProcessIdentities $state.ReleaseProcessIdentities -Control $Control }.GetNewClosure()
        [void](Receive-IntentArcBoundedProcessOutput -StandardOutput $process.StandardOutput.BaseStream -StandardError $process.StandardError.BaseStream -Control $Control -Heartbeat $discover)
        Update-IntentArcRecordedProcessIdentities -ProcessIdentities $state.ReleaseProcessIdentities -Control $Control
        if (-not $process.HasExited) { throw 'release' }
        if ($process.ExitCode -ne 0) { throw 'release' }
        Assert-IntentArcReleaseExecutionInputs -Manifest $Manifest -PreviousRecords $releaseInputRecords | Out-Null
        return [ordered]@{
            releaseInvocations = 1; nestedMakeInvocations = 1
            forbiddenLifecycleCount = 0; externalPublicationCount = 0
        }
    }.GetNewClosure()) -Metadata ([ordered]@{
        name = 'InvokeRelease'; classification = 'release'; executable = 'manifest.release.executablePath'
        executableSha256 = 'manifest.release.executableSha256'
        arguments = @('desktop:release'); shell = $false; maximumCallSites = 1
    })

    $operations['VerifyRelease'] = Add-IntentArcSignedReleaseOperationMetadata -Operation ({
        param($Manifest, $Thumbprint)
        $paths = @(
            (Join-Path $Manifest.repository.root 'out\IntentArc-win32-x64\IntentArc.exe'),
            (Join-Path $Manifest.repository.root 'out\IntentArc-win32-x64\resources\bridge\IntentArc Bridge.exe'),
            (Join-Path $Manifest.repository.root 'out\make\squirrel.windows\x64\IntentArc Setup.exe')
        )
        foreach ($path in $paths) {
            [void](Get-IntentArcConfirmedExistingTarget -LiteralRoot $Manifest.repository.root -LiteralCandidate $path)
            $signature = Get-AuthenticodeSignature -LiteralPath $path
            if ($signature.Status -ne [Management.Automation.SignatureStatus]::Valid -or
                $null -eq $signature.SignerCertificate -or
                -not [string]::Equals($signature.SignerCertificate.Thumbprint, $Thumbprint, [StringComparison]::OrdinalIgnoreCase)) {
                throw 'signature-verification'
            }
        }
        return [ordered]@{ signatureVerified = $true }
    }.GetNewClosure()) -Metadata ([ordered]@{ name = 'VerifyRelease'; classification = 'verification' })

    $operations['PublishClosedArtifactBundle'] = Add-IntentArcSignedReleaseOperationMetadata -Operation ({
        param($Manifest, $Thumbprint, $PublicationState, $Control)
        $artifactParent = Split-Path -Parent $Manifest.paths.artifactRoot
        [void](Get-IntentArcConfirmedExistingTarget -LiteralRoot $artifactParent -LiteralCandidate $artifactParent)
        if ([IO.Directory]::Exists($PublicationState.stagingRoot) -or [IO.File]::Exists($PublicationState.stagingRoot) -or
            [IO.Directory]::Exists($PublicationState.finalRoot) -or [IO.File]::Exists($PublicationState.finalRoot) -or
            -not [string]::Equals($PublicationState.stagingRoot, ($Manifest.paths.artifactRoot + '.staging'), [StringComparison]::OrdinalIgnoreCase) -or
            -not [string]::Equals($PublicationState.finalRoot, $Manifest.paths.artifactRoot, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'artifact-bundle-failed'
        }
        [IO.Directory]::CreateDirectory($PublicationState.stagingRoot) | Out-Null
        $publisherDestination = Join-Path $PublicationState.stagingRoot 'publisher.cer'
        $canonicalCer = Get-IntentArcConfirmedExistingTarget -LiteralRoot (Split-Path -Parent $Manifest.paths.cer) -LiteralCandidate $Manifest.paths.cer
        [void](Get-IntentArcConfirmedExistingTarget -LiteralRoot $artifactParent -LiteralCandidate $PublicationState.stagingRoot)
        [IO.File]::Copy($canonicalCer, $publisherDestination, $false)
        [void](Get-IntentArcConfirmedExistingTarget -LiteralRoot $artifactParent -LiteralCandidate $publisherDestination)
        $payloadSources = @(
            [ordered]@{ source = (Join-Path $Manifest.repository.root 'dist\bridge'); relative = 'dist\bridge' },
            [ordered]@{ source = (Join-Path $Manifest.repository.root 'out\IntentArc-win32-x64\IntentArc.exe'); relative = 'out\IntentArc-win32-x64\IntentArc.exe' },
            [ordered]@{ source = (Join-Path $Manifest.repository.root 'out\IntentArc-win32-x64\resources\bridge\IntentArc Bridge.exe'); relative = 'out\IntentArc-win32-x64\resources\bridge\IntentArc Bridge.exe' },
            [ordered]@{ source = (Join-Path $Manifest.repository.root 'out\make\squirrel.windows\x64'); relative = 'out\make\squirrel.windows\x64' }
        )
        foreach ($payload in $payloadSources) {
            $canonicalSource = Get-IntentArcConfirmedExistingTarget -LiteralRoot $Manifest.repository.root -LiteralCandidate $payload.source
            $destination = Join-Path $PublicationState.stagingRoot $payload.relative
            [void](Get-IntentArcConfirmedExistingTarget -LiteralRoot $artifactParent -LiteralCandidate $PublicationState.stagingRoot)
            $destinationParent = Split-Path -Parent $destination
            [IO.Directory]::CreateDirectory($destinationParent) | Out-Null
            if ([IO.Directory]::Exists($canonicalSource)) {
                Copy-IntentArcExactTree -LiteralSourceRoot $Manifest.repository.root -LiteralSource $canonicalSource -LiteralDestinationRoot $artifactParent -LiteralDestination $destination
            } else {
                Copy-IntentArcExactTree -LiteralSourceRoot $Manifest.repository.root -LiteralSource $canonicalSource -LiteralDestinationRoot $artifactParent -LiteralDestination $destination
            }
        }
        $rowsByPath = @{}
        $bundlePrefixLength = $PublicationState.stagingRoot.TrimEnd([char[]]@('\', '/')).Length + 1
        foreach ($file in @(Get-IntentArcExactTreeFiles -LiteralRoot $artifactParent -LiteralPath $PublicationState.stagingRoot)) {
            $relative = $file.Substring($bundlePrefixLength).Replace('\', '/')
            if ([string]::Equals($relative, 'publisher.cer', [StringComparison]::Ordinal)) { continue }
            $algorithm = [Security.Cryptography.SHA256]::Create()
            try {
                $canonicalFile = Get-IntentArcConfirmedExistingTarget -LiteralRoot $artifactParent -LiteralCandidate $file
                $bytes = [IO.File]::ReadAllBytes($canonicalFile)
                [void](Get-IntentArcConfirmedExistingTarget -LiteralRoot $artifactParent -LiteralCandidate $canonicalFile)
                if ($rowsByPath.ContainsKey($relative)) { throw 'artifact-bundle-failed' }
                $rowsByPath[$relative] = [ordered]@{
                    path = $relative; bytes = $bytes.Length
                    sha256 = ([BitConverter]::ToString($algorithm.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
                }
            } finally { $algorithm.Dispose() }
        }
        $orderedPaths = [string[]]@($rowsByPath.Keys)
        [Array]::Sort($orderedPaths, [StringComparer]::Ordinal)
        $orderedRows = @($orderedPaths | ForEach-Object { $rowsByPath[$_] })
        if ($orderedRows.Count -eq 0 -or $orderedRows.Count -gt 64) { throw 'artifact-bundle-failed' }
        $package = [IO.File]::ReadAllText((Join-Path $Manifest.repository.root 'package.json')) | ConvertFrom-Json
        $cerAlgorithm = [Security.Cryptography.SHA256]::Create()
        try {
            $bundleManifest = [ordered]@{
                bundleId = [string]$Manifest.run.id
                files = $orderedRows
                publisher = [ordered]@{
                    cerSha256 = ([BitConverter]::ToString($cerAlgorithm.ComputeHash([IO.File]::ReadAllBytes($publisherDestination)))).Replace('-', '').ToLowerInvariant()
                    subject = [string]$state.Certificate.Subject
                    thumbprint = $Thumbprint
                }
                schemaVersion = 1
                source = [ordered]@{
                    commit = [string]$Manifest.repository.commit
                    packageVersion = [string]$package.version
                    verifierSha256 = [string]$Manifest.release.verifierScriptSha256
                }
                verification = [ordered]@{ bridgeNative = $true; bundleClosure = $true; releaseExecutables = $true }
            }
        } finally {
            $cerAlgorithm.Dispose()
        }
        $manifestPath = Join-Path $PublicationState.stagingRoot 'bundle.json'
        [void](Get-IntentArcConfirmedExistingTarget -LiteralRoot $artifactParent -LiteralCandidate $PublicationState.stagingRoot)
        $manifestBytes = [Text.UTF8Encoding]::new($false, $true).GetBytes(($bundleManifest | ConvertTo-Json -Depth 8 -Compress))
        $stream = [IO.File]::Open($manifestPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $stream.Write($manifestBytes, 0, $manifestBytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
        $manifestAlgorithm = [Security.Cryptography.SHA256]::Create()
        try {
            $manifestSha256 = ([BitConverter]::ToString($manifestAlgorithm.ComputeHash($manifestBytes))).Replace('-', '').ToLowerInvariant()
        } finally { $manifestAlgorithm.Dispose() }
        $verifierNodeRecord = Assert-IntentArcBoundFileHash -LiteralPath $Manifest.release.verifierExecutablePath -ExpectedLeaf 'node.exe' -ExpectedSha256 $Manifest.release.verifierExecutableSha256
        $verifierInfo = New-IntentArcVerifierProcessStartInfo `
            -Executable $Manifest.release.verifierExecutablePath `
            -ScriptPath $Manifest.release.verifierScriptPath `
            -BundleRoot $PublicationState.stagingRoot `
            -ExpectedThumbprint $Thumbprint `
            -WorkingDirectory $Manifest.repository.root `
            -AuditRoot (Split-Path -Parent $Manifest.paths.consumedMarker) `
            -AuditPath (Join-Path (Split-Path -Parent $Manifest.paths.consumedMarker) 'bridge-diagnostics.tokens')
        $verifierProcess = New-Object Diagnostics.Process
        $verifierProcess.StartInfo = $verifierInfo
        try {
            if (-not $verifierProcess.Start()) { throw 'artifact-verifier-start' }
            [void]$state.ReleaseProcessIds.Add($verifierProcess.Id)
            $state.ReleaseProcessIdentities[[string]$verifierProcess.Id] = $verifierProcess.StartTime.ToUniversalTime().Ticks
            $discoverVerifier = { Update-IntentArcRecordedProcessIdentities -ProcessIdentities $state.ReleaseProcessIdentities -Control $Control }.GetNewClosure()
            $killVerifier = { Stop-IntentArcBoundProcessTree -Process $verifierProcess }.GetNewClosure()
            $captured = Receive-IntentArcVerifierOutputBoundary -StandardOutput $verifierProcess.StandardOutput.BaseStream -StandardError $verifierProcess.StandardError.BaseStream -Control $Control -Kill $killVerifier -Heartbeat $discoverVerifier
            Update-IntentArcRecordedProcessIdentities -ProcessIdentities $state.ReleaseProcessIdentities -Control $Control
            if (-not $verifierProcess.HasExited) { throw 'artifact-verifier-timeout' }
            if ((Get-IntentArcActiveRecordedProcessIdentityCount -ProcessIdentities $state.ReleaseProcessIdentities) -ne 0) {
                throw 'artifact-verifier-settlement'
            }
            $stdout = [string]$captured.stdout
            if ($verifierProcess.ExitCode -ne 0) {
                $auditFailureSignalBytes = 72
                $auditFailureSignalSha256 = '72b30966cdd29e33525b6ef2beb2d124a4382418e0fd9b35e266df7dc0f159dd'
                if ($verifierProcess.ExitCode -eq 2 -and
                    $captured.stdoutBytes -eq 0 -and
                    $captured.stderrBytes -eq $auditFailureSignalBytes -and
                    $captured.stderrSha256 -ceq $auditFailureSignalSha256) {
                    throw 'bridge-diagnostic-audit'
                }
                throw 'artifact-verifier-failed'
            }
            Assert-IntentArcBoundFileHash -LiteralPath $Manifest.release.verifierExecutablePath -ExpectedLeaf 'node.exe' -ExpectedSha256 $Manifest.release.verifierExecutableSha256 -PreviousRecord $verifierNodeRecord | Out-Null
            $evidence = ConvertFrom-IntentArcArtifactVerifierEvidence `
                -Json $stdout `
                -ExpectedBundleId $Manifest.run.id `
                -ExpectedCommit $Manifest.repository.commit `
                -ExpectedThumbprint $Thumbprint `
                -ExpectedVerifierSha256 $Manifest.release.verifierScriptSha256
        } catch {
            try { Stop-IntentArcBoundProcessTree -Process $verifierProcess } catch { throw 'artifact-verifier-settlement' }
            try { Assert-IntentArcBoundFileHash -LiteralPath $Manifest.release.verifierExecutablePath -ExpectedLeaf 'node.exe' -ExpectedSha256 $Manifest.release.verifierExecutableSha256 -PreviousRecord $verifierNodeRecord } catch { throw 'artifact-verifier-drift' }
            if ($_.Exception.Message -in @('interruption', 'timeout')) { throw $_.Exception.Message }
            if ($_.Exception.Message -ceq 'bridge-diagnostic-audit') { throw 'bridge-diagnostic-audit' }
            throw 'artifact-verification'
        } finally {
            $verifierProcess.Dispose()
        }
        if ($evidence.bridgeDiagnosticInvocationCount -ne 5) {
            throw 'bridge-diagnostic-audit'
        }
        $canonicalStaging = Get-IntentArcConfirmedExistingTarget -LiteralRoot $artifactParent -LiteralCandidate $PublicationState.stagingRoot
        [void](Get-IntentArcConfirmedExistingTarget -LiteralRoot $artifactParent -LiteralCandidate $artifactParent)
        if ([IO.Directory]::Exists($PublicationState.finalRoot) -or [IO.File]::Exists($PublicationState.finalRoot)) { throw 'artifact-bundle-failed' }
        Assert-IntentArcSignedReleaseContinuation -CancellationToken $Control.cancellationToken -DeadlineUtc $Control.deadlineUtc
        [IO.Directory]::Move($canonicalStaging, $PublicationState.finalRoot)
        [void](Get-IntentArcConfirmedExistingTarget -LiteralRoot $artifactParent -LiteralCandidate $PublicationState.finalRoot)
        $PublicationState.published = $true
        $state.Published = $true
        return [ordered]@{
            published = $true
            artifactManifestSha256 = $manifestSha256
            signatureVerified = $evidence.signatureVerified
            bridgePredecessorVerified = $evidence.bridgePredecessorVerified
            artifactVerified = $evidence.artifactVerified
            bridgeDiagnosticInvocationCount = $evidence.bridgeDiagnosticInvocationCount
        }
    }.GetNewClosure()) -Metadata ([ordered]@{
        name = 'PublishClosedArtifactBundle'; classification = 'contained-publication'
        container = 'preexisting-repository/.superpowers/artifacts'; external = $false
        verifierExecutable = 'manifest.release.verifierExecutablePath'
        verifierScript = 'manifest.release.verifierScriptPath'; evidence = 'closed-json'
    })

    $operations['SettleDescendants'] = Add-IntentArcSignedReleaseOperationMetadata -Operation ({
        param($Manifest, $Control)
        if ($null -eq $Control) {
            $Control = [pscustomobject]@{ cancellationToken = [Threading.CancellationToken]::None; deadlineUtc = [DateTime]::UtcNow.AddSeconds(5) }
        }
        $settlementDeadline = [DateTime]::UtcNow.AddSeconds(5)
        if ($Control.deadlineUtc -lt $settlementDeadline) { $settlementDeadline = $Control.deadlineUtc }
        $settlementControl = [pscustomobject]@{ cancellationToken = $Control.cancellationToken; deadlineUtc = $settlementDeadline }
        $discoveryComplete = $true
        for ($round = 0; $round -lt 3; $round++) {
            Assert-IntentArcSignedReleaseContinuation -CancellationToken $settlementControl.cancellationToken -DeadlineUtc $settlementControl.deadlineUtc
            try {
                Update-IntentArcRecordedProcessIdentities -ProcessIdentities $state.ReleaseProcessIdentities -Control $settlementControl
            } catch {
                $discoveryComplete = $false
            }
            [int[]]$ids = @($state.ReleaseProcessIdentities.Keys | ForEach-Object { [int]$_ })
            [Array]::Sort($ids)
            [Array]::Reverse($ids)
            foreach ($id in $ids) {
                Assert-IntentArcSignedReleaseContinuation -CancellationToken $settlementControl.cancellationToken -DeadlineUtc $settlementControl.deadlineUtc
                try {
                    $candidate = [Diagnostics.Process]::GetProcessById($id)
                    try {
                        $expectedTicks = [long]$state.ReleaseProcessIdentities[[string]$id]
                        if (-not $candidate.HasExited -and $candidate.StartTime.ToUniversalTime().Ticks -eq $expectedTicks) {
                            $candidate.Kill()
                        }
                    } finally { $candidate.Dispose() }
                } catch [ArgumentException] { } catch { $discoveryComplete = $false }
            }
            while ((Get-IntentArcActiveRecordedProcessIdentityCount -ProcessIdentities $state.ReleaseProcessIdentities) -ne 0) {
                Assert-IntentArcSignedReleaseContinuation -CancellationToken $settlementControl.cancellationToken -DeadlineUtc $settlementControl.deadlineUtc
                Start-Sleep -Milliseconds 25
            }
        }
        if ($null -ne $state.ReleaseProcess) {
            try {
                if (-not $state.ReleaseProcess.HasExited) { throw 'descendant-settlement' }
            } finally {
                $state.ReleaseProcess.Dispose(); $state.ReleaseProcess = $null
            }
        }
        $remaining = Get-IntentArcActiveRecordedProcessIdentityCount -ProcessIdentities $state.ReleaseProcessIdentities
        if (-not $discoveryComplete) {
            throw 'descendant-settlement'
        }
        Assert-IntentArcReleaseExecutionInputs -Manifest $Manifest -PreviousRecords $state.ReleaseExecutionInputRecords | Out-Null
        return [ordered]@{ processCount = $remaining }
    }.GetNewClosure()) -Metadata ([ordered]@{
        name = 'SettleDescendants'; classification = 'cleanup'; proof = 'zero-active-recorded-processes'
        discoveryFailure = 'descendant-settlement'; serializesProcessIds = $false
    })

    $operations['ClearSigningEnvironment'] = Add-IntentArcSignedReleaseOperationMetadata -Operation ({
        foreach ($name in @(
            'INTENTARC_WINDOWS_CERTIFICATE', 'INTENTARC_WINDOWS_CERTIFICATE_PASSWORD',
            'INTENTARC_WINDOWS_CERTIFICATE_THUMBPRINT', 'INTENTARC_BRIDGE_AUTHORIZED_PREDECESSOR'
        )) {
            [Environment]::SetEnvironmentVariable($name, $null, [EnvironmentVariableTarget]::Process)
        }
        $state.PasswordValue = $null
        if ($null -ne $state.SecurePassword) { $state.SecurePassword.Dispose(); $state.SecurePassword = $null }
    }.GetNewClosure()) -Metadata ([ordered]@{ name = 'ClearSigningEnvironment'; classification = 'cleanup' })

    $operations['RemoveTrust'] = Add-IntentArcSignedReleaseOperationMetadata -Operation ({
        param($Thumbprint, $TrustStore)
        if ($TrustStore -notin @('Cert:\CurrentUser\Root', 'Cert:\CurrentUser\TrustedPublisher')) { throw 'trust-removal-invalid' }
        Remove-IntentArcExactStoreCertificates -Thumbprint $Thumbprint -LiteralStore $TrustStore
    }.GetNewClosure()) -Metadata ([ordered]@{ name = 'RemoveTrust'; classification = 'cleanup' })

    $operations['RemoveCertificate'] = Add-IntentArcSignedReleaseOperationMetadata -Operation ({
        param($Thumbprint, $MyStore)
        if (-not [string]::Equals($MyStore, 'Cert:\CurrentUser\My', [StringComparison]::Ordinal)) { throw 'certificate-removal-invalid' }
        Remove-IntentArcExactStoreCertificates -Thumbprint $Thumbprint -LiteralStore $MyStore
        if ($null -ne $state.Certificate) { $state.Certificate.Dispose(); $state.Certificate = $null }
    }.GetNewClosure()) -Metadata ([ordered]@{ name = 'RemoveCertificate'; classification = 'cleanup' })

    $operations['RemoveCngKey'] = Add-IntentArcSignedReleaseOperationMetadata -Operation ({
        param($KeyIdentifier)
        if ($null -eq $KeyIdentifier) { return }
        if (-not [string]::Equals($KeyIdentifier, $state.KeyIdentifier, [StringComparison]::Ordinal) -or $KeyIdentifier -cnotmatch '^[A-Za-z0-9._-]{1,128}$') {
            throw 'cng-key-removal-invalid'
        }
        $provider = [Security.Cryptography.CngProvider]::new('Microsoft Software Key Storage Provider')
        if ([Security.Cryptography.CngKey]::Exists($KeyIdentifier, $provider)) {
            $key = [Security.Cryptography.CngKey]::Open($KeyIdentifier, $provider)
            try { $key.Delete() } finally { $key.Dispose() }
        }
    }.GetNewClosure()) -Metadata ([ordered]@{ name = 'RemoveCngKey'; classification = 'cleanup' })

    $operations['RemoveExactFile'] = Add-IntentArcSignedReleaseOperationMetadata -Operation ({
        param($LiteralPath)
        if ($null -eq $LiteralPath) { return }
        if (-not [string]::Equals($LiteralPath, $state.PfxPath, [StringComparison]::OrdinalIgnoreCase) -and
            -not [string]::Equals($LiteralPath, $state.CerPath, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'exact-file-removal-invalid'
        }
        if ([IO.File]::Exists($LiteralPath)) {
            $parent = Split-Path -Parent $LiteralPath
            $canonical = Get-IntentArcConfirmedExistingTarget -LiteralRoot $parent -LiteralCandidate $LiteralPath
            [IO.File]::Delete($canonical)
        }
    }.GetNewClosure()) -Metadata ([ordered]@{ name = 'RemoveExactFile'; classification = 'cleanup' })

    $operations['RemoveRuntime'] = Add-IntentArcSignedReleaseOperationMetadata -Operation ({
        param($LiteralPath)
        if (-not [string]::Equals($LiteralPath, $state.Manifest.paths.runtime, [StringComparison]::OrdinalIgnoreCase)) { throw 'runtime-removal-invalid' }
        if ([IO.Directory]::Exists($LiteralPath) -or [IO.File]::Exists($LiteralPath)) {
            $runRoot = Split-Path -Parent $state.Manifest.paths.consumedMarker
            Remove-IntentArcExactTree -LiteralRoot $runRoot -LiteralPath $LiteralPath
        }
    }.GetNewClosure()) -Metadata ([ordered]@{ name = 'RemoveRuntime'; classification = 'cleanup' })

    $operations['RemovePartialArtifactBundle'] = Add-IntentArcSignedReleaseOperationMetadata -Operation ({
        param($ArtifactRoot, $LiteralPath)
        if ($state.Published -or $null -eq $state.Manifest -or
            -not [string]::Equals($ArtifactRoot, $state.Manifest.paths.artifactRoot, [StringComparison]::OrdinalIgnoreCase) -or
            (-not [string]::Equals($LiteralPath, ($ArtifactRoot + '.staging'), [StringComparison]::OrdinalIgnoreCase) -and
             -not [string]::Equals($LiteralPath, $ArtifactRoot, [StringComparison]::OrdinalIgnoreCase))) {
            throw 'artifact-rollback-invalid'
        }
        if ([IO.Directory]::Exists($LiteralPath) -or [IO.File]::Exists($LiteralPath)) {
            $parent = Split-Path -Parent $ArtifactRoot
            Remove-IntentArcExactTree -LiteralRoot $parent -LiteralPath $LiteralPath
        }
    }.GetNewClosure()) -Metadata ([ordered]@{
        name = 'RemovePartialArtifactBundle'; classification = 'cleanup'
        targets = @('artifactRoot.staging', 'artifactRoot.final'); order = @('staging', 'final')
        requiresUnpublished = $true; ownership = 'manifest-exact'
    })

    $operations['RemoveGeneratedOutput'] = Add-IntentArcSignedReleaseOperationMetadata -Operation ({
        param($RepositoryRoot, $LiteralPath)
        if ($LiteralPath -cnotin @((Join-Path $RepositoryRoot 'dist'), (Join-Path $RepositoryRoot 'out'))) { throw 'generated-output-removal-invalid' }
        if ([IO.Directory]::Exists($LiteralPath) -or [IO.File]::Exists($LiteralPath)) {
            Remove-IntentArcExactTree -LiteralRoot $RepositoryRoot -LiteralPath $LiteralPath
        }
    }.GetNewClosure()) -Metadata ([ordered]@{ name = 'RemoveGeneratedOutput'; classification = 'cleanup' })

    $operations['RestoreOutputRoot'] = Add-IntentArcSignedReleaseOperationMetadata -Operation ({
        param($RepositoryRoot, $RecoveryRoot, $Preserved)
        $runRoot = Split-Path -Parent $state.Manifest.paths.consumedMarker
        if (-not [string]::Equals($RecoveryRoot, (Join-Path $runRoot 'recovery'), [StringComparison]::OrdinalIgnoreCase)) { throw 'output-restoration-invalid' }
        foreach ($name in @('dist', 'out')) {
            if ($Preserved[$name] -cnotin @('moving', 'preserved')) { continue }
            $source = Join-Path $RecoveryRoot $name
            $destination = Join-Path $RepositoryRoot $name
            $sourceExists = [IO.Directory]::Exists($source)
            $destinationExists = [IO.Directory]::Exists($destination)
            if ($sourceExists -eq $destinationExists) { throw 'restoration-presence-uncertain' }
            if ($sourceExists) {
                $canonicalSource = Get-IntentArcConfirmedExistingTarget -LiteralRoot $RecoveryRoot -LiteralCandidate $source
                [void](Get-IntentArcConfirmedExistingTarget -LiteralRoot $RepositoryRoot -LiteralCandidate $RepositoryRoot)
                [IO.Directory]::Move($canonicalSource, $destination)
            }
        }
        if ([IO.Directory]::Exists($RecoveryRoot)) {
            $canonicalRecovery = Get-IntentArcConfirmedExistingTarget -LiteralRoot $runRoot -LiteralCandidate $RecoveryRoot
            if ([IO.Directory]::GetFileSystemEntries($canonicalRecovery).Count -ne 0) { throw 'output-restoration-invalid' }
            [IO.Directory]::Delete($canonicalRecovery, $false)
        }
        return [ordered]@{ restored = $true }
    }.GetNewClosure()) -Metadata ([ordered]@{ name = 'RestoreOutputRoot'; classification = 'cleanup' })

    $operations['GetAfterProjection'] = Add-IntentArcSignedReleaseOperationMetadata -Operation ({
        param($Manifest, $Before)
        $distProjection = Get-IntentArcResidueProjection -LiteralRoot (Join-Path $Manifest.repository.root 'dist')
        $outProjection = Get-IntentArcResidueProjection -LiteralRoot (Join-Path $Manifest.repository.root 'out')
        $distComparison = Compare-IntentArcResidueProjection -Expected $state.BeforeDist -Actual $distProjection
        $outComparison = Compare-IntentArcResidueProjection -Expected $state.BeforeOut -Actual $outProjection
        $environmentNames = @(
            'INTENTARC_WINDOWS_CERTIFICATE', 'INTENTARC_WINDOWS_CERTIFICATE_PASSWORD',
            'INTENTARC_WINDOWS_CERTIFICATE_THUMBPRINT', 'INTENTARC_BRIDGE_AUTHORIZED_PREDECESSOR'
        )
        $environmentCount = @($environmentNames | Where-Object {
            -not [string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable($_, [EnvironmentVariableTarget]::Process))
        }).Count
        $runRoot = Split-Path -Parent $Manifest.paths.consumedMarker
        $recoveryRoot = Join-Path $runRoot 'recovery'
        $stagingRoot = $Manifest.paths.artifactRoot + '.staging'
        $storeRestored = (
            (Get-IntentArcExactCertificateCount -LiteralStore $Manifest.certificate.myStore -Subject $Manifest.certificate.subject) -eq $Before.myCertificate -and
            (Get-IntentArcExactCertificateCount -LiteralStore $Manifest.certificate.trustStores[0] -Subject $Manifest.certificate.subject) -eq $Before.rootTrust -and
            (Get-IntentArcExactCertificateCount -LiteralStore $Manifest.certificate.trustStores[1] -Subject $Manifest.certificate.subject) -eq $Before.trustedPublisherTrust
        )
        return [ordered]@{
            storeProjectionRestored = $storeRestored
            outputProjectionRestored = ($distComparison.equal -and $outComparison.equal)
            artifactPublicationClean = (-not [IO.Directory]::Exists($stagingRoot) -and -not [IO.File]::Exists($stagingRoot) -and ($state.Published -eq ([IO.Directory]::Exists($Manifest.paths.artifactRoot) -or [IO.File]::Exists($Manifest.paths.artifactRoot))))
            residue = [ordered]@{
                myCertificate = Get-IntentArcExactCertificateCount -LiteralStore $Manifest.certificate.myStore -Subject $Manifest.certificate.subject
                rootTrust = Get-IntentArcExactCertificateCount -LiteralStore $Manifest.certificate.trustStores[0] -Subject $Manifest.certificate.subject
                trustedPublisherTrust = Get-IntentArcExactCertificateCount -LiteralStore $Manifest.certificate.trustStores[1] -Subject $Manifest.certificate.subject
                cngKey = Get-IntentArcRecordedCngKeyResidueCount -KeyIdentifier $state.KeyIdentifier
                pfx = [int]([IO.File]::Exists($Manifest.paths.pfx) -or [IO.Directory]::Exists($Manifest.paths.pfx))
                cer = [int]([IO.File]::Exists($Manifest.paths.cer) -or [IO.Directory]::Exists($Manifest.paths.cer))
                runtime = [int]([IO.Directory]::Exists($Manifest.paths.runtime) -or [IO.File]::Exists($Manifest.paths.runtime))
                process = Get-IntentArcActiveRecordedProcessIdentityCount -ProcessIdentities $state.ReleaseProcessIdentities
                signingEnvironment = [int]($environmentCount -ne 0)
                generatedDist = [int](-not $distComparison.equal)
                generatedOut = [int](-not $outComparison.equal)
                recoveryDirectory = [int]([IO.Directory]::Exists($recoveryRoot))
            }
        }
    }.GetNewClosure()) -Metadata ([ordered]@{ name = 'GetAfterProjection'; classification = 'observation' })

    $operations['WriteReceiptAtomic'] = Add-IntentArcSignedReleaseOperationMetadata -Operation ({
        param($LiteralPath, $Receipt)
        if ($null -eq $state.Manifest -or $null -eq $state.Manifest.run -or $state.Manifest.run.id -isnot [string]) { throw 'receipt-writing' }
        Write-IntentArcSignedReleaseReceiptAtomic -LiteralPath $LiteralPath -Receipt $Receipt -ExpectedRunId $state.Manifest.run.id
    }.GetNewClosure()) -Metadata ([ordered]@{ name = 'WriteReceiptAtomic'; classification = 'mutation' })

    if (-not (Test-IntentArcSignedReleaseOperations -Operations $operations)) {
        throw 'production-operations-invalid'
    }
    return $operations
}

function Invoke-IntentArcSignedReleaseStaticSelfTest {
    $mutations = [pscustomobject]@{ Value = 0 }
    $productionOperations = New-IntentArcSignedReleaseOperations
    if (-not (Test-IntentArcSignedReleaseOperations -Operations $productionOperations)) {
        throw 'static-self-test-invalid'
    }
    $sourcePolicy = Test-IntentArcSignedReleaseSourcePolicy -Source ([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'signed-release-once.ps1')))
    if (-not $sourcePolicy.valid) {
        throw 'static-self-test-invalid'
    }
    $operations = @{}
    foreach ($name in Get-IntentArcSignedReleaseOperationNames) {
        $operations[$name] = { $mutations.Value++ }.GetNewClosure()
    }
    if (-not (Test-IntentArcSignedReleaseOperations -Operations $operations)) {
        throw 'static-self-test-invalid'
    }
    [Console]::Out.WriteLine((([ordered]@{ status = 'STATIC_PASS'; mutations = $mutations.Value }) | ConvertTo-Json -Compress))
}

function Write-IntentArcSignedReleaseHostRefusal {
    param([Parameter(Mandatory)][string] $Category)

    [Console]::Out.WriteLine((([ordered]@{ status = 'REFUSED'; category = $Category; mutations = 0 }) | ConvertTo-Json -Compress))
}

if ($MyInvocation.InvocationName -ne '.') {
    if ($StaticSelfTest -and -not $Execute) {
        Invoke-IntentArcSignedReleaseStaticSelfTest
        exit 0
    }
    if (-not $Execute) {
        Write-IntentArcSignedReleaseHostRefusal -Category 'execute-required'
        exit 1
    }
    if ([string]::IsNullOrWhiteSpace($AuthorizationManifest) -or -not [IO.Path]::IsPathRooted($AuthorizationManifest) -or $ExpectedAuthorizationSha256 -cnotmatch '^[0-9a-f]{64}$') {
        Write-IntentArcSignedReleaseHostRefusal -Category 'execute-gate-invalid'
        exit 1
    }

    $actualHostInvocation = [Environment]::CommandLine
    try {
        $manifest = Read-IntentArcSignedAuthorizationManifest `
            -LiteralPath $AuthorizationManifest `
            -ExpectedSha256 $ExpectedAuthorizationSha256 `
            -ActualInvocation $actualHostInvocation
    } catch {
        Write-IntentArcSignedReleaseHostRefusal -Category 'authorization-refused'
        exit 1
    }
    try {
        $operations = New-IntentArcSignedReleaseOperations
        $result = Invoke-IntentArcSignedReleaseOnce -Manifest $manifest -Operations $operations -ActualInvocation $actualHostInvocation
        [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress))
        if ($result.status -ne 'PASS') {
            exit 1
        }
    } catch {
        if ($_.Exception.Message -ceq 'receipt-writing') {
            exit 1
        }
        Write-IntentArcSignedReleaseHostRefusal -Category 'production-operations-unavailable'
        exit 1
    }
}
