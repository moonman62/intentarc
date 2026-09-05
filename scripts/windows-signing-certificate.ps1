[CmdletBinding()]
param(
  [switch]$StaticSelfTest
)

function Get-IntentArcRsaPrivateKey {
  param(
    [Parameter(Mandatory = $true)]
    [Security.Cryptography.X509Certificates.X509Certificate2] $Certificate
  )

  [Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($Certificate)
}

function Invoke-IntentArcCertificateStage {
  param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('certificate-create', 'private-key-open', 'certificate-export', 'public-certificate-export', 'thumbprint-verify')]
    [string] $Category,
    [Parameter(Mandatory = $true)]
    [scriptblock] $Operation,
    [object[]] $Arguments = @()
  )

  $priorErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Stop'
    $contextVariables = New-Object `
      'Collections.Generic.List[Management.Automation.PSVariable]'
    $contextVariable = New-Object `
      Management.Automation.PSVariable `
      -ArgumentList @(
        'ErrorActionPreference',
        [Management.Automation.ActionPreference]::Stop
      )
    $contextVariables.Add($contextVariable)
    $Operation.InvokeWithContext($null, $contextVariables, $Arguments)
  } catch {
    throw "IntentArc signing certificate preparation failed: $Category."
  } finally {
    $ErrorActionPreference = $priorErrorActionPreference
  }
}

function Get-IntentArcSigningCertificateCommands {
  @{
    'certificate-create' = {
      param($Subject, $CertStoreLocation, $KeyContainerName, $CreationState)
      $createdCertificate = New-SelfSignedCertificate `
        -Subject $Subject `
        -CertStoreLocation $CertStoreLocation `
        -Container $KeyContainerName `
        -Type CodeSigningCert `
        -KeyExportPolicy Exportable `
        -KeyAlgorithm RSA `
        -KeyLength 3072 `
        -HashAlgorithm SHA256 `
        -KeySpec Signature `
        -Provider 'Microsoft Software Key Storage Provider' `
        -ErrorAction Stop
      if ($null -ne $CreationState) {
        $CreationState.certificate = $createdCertificate
        $CreationState.thumbprint = $createdCertificate.Thumbprint
      }
      return $createdCertificate
    }
    'private-key-open' = {
      param($Certificate)
      $rsa = Get-IntentArcRsaPrivateKey -Certificate $Certificate
      if ($null -eq $rsa) { throw 'private key unavailable' }
      try { $true } finally { $rsa.Dispose() }
    }
    'certificate-export' = {
      param($Certificate, $PfxPath, $Password)
      [void](Export-PfxCertificate `
        -Cert $Certificate `
        -FilePath $PfxPath `
        -Password $Password `
        -Force `
        -ErrorAction Stop)
      $true
    }
    'public-certificate-export' = {
      param($Certificate, $PublicCertificatePath)
      [void](Export-Certificate `
        -Cert $Certificate `
        -FilePath $PublicCertificatePath `
        -Type CERT `
        -Force `
        -ErrorAction Stop)
      $true
    }
    'thumbprint-verify' = {
      param($Certificate, $PublicCertificatePath)
      $bytes = [IO.File]::ReadAllBytes($PublicCertificatePath)
      $observed = New-Object `
        Security.Cryptography.X509Certificates.X509Certificate2 `
        -ArgumentList @(,$bytes)
      try {
        if ($observed.Thumbprint.ToUpperInvariant() -cne $Certificate.Thumbprint.ToUpperInvariant()) {
          throw 'thumbprint mismatch'
        }
        $true
      } finally {
        $observed.Dispose()
      }
    }
  }
}

function New-IntentArcSigningCertificate {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Subject,
    [Parameter(Mandatory = $true)]
    [string] $CertStoreLocation,
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9._-]{1,128}$')]
    [string] $KeyContainerName,
    [Parameter(Mandatory = $true)]
    [string] $PfxPath,
    [Parameter(Mandatory = $true)]
    [string] $PublicCertificatePath,
    [Parameter(Mandatory = $true)]
    [Security.SecureString] $Password,
    [hashtable] $Commands
  )

  if ($null -eq $Commands) {
    $Commands = Get-IntentArcSigningCertificateCommands
  }

  $categories = @(
    'certificate-create',
    'private-key-open',
    'certificate-export',
    'public-certificate-export',
    'thumbprint-verify'
  )
  foreach ($category in $categories) {
    if (-not $Commands.ContainsKey($category) -or $Commands[$category] -isnot [scriptblock]) {
      throw 'IntentArc signing certificate preparation configuration invalid.'
    }
  }

  $certificate = Invoke-IntentArcCertificateStage `
    -Category 'certificate-create' `
    -Operation $Commands['certificate-create'] `
    -Arguments @($Subject, $CertStoreLocation, $KeyContainerName)
  [void](Invoke-IntentArcCertificateStage `
    -Category 'private-key-open' `
    -Operation $Commands['private-key-open'] `
    -Arguments @(,$certificate))
  [void](Invoke-IntentArcCertificateStage `
    -Category 'certificate-export' `
    -Operation $Commands['certificate-export'] `
    -Arguments @($certificate, $PfxPath, $Password))
  [void](Invoke-IntentArcCertificateStage `
    -Category 'public-certificate-export' `
    -Operation $Commands['public-certificate-export'] `
    -Arguments @($certificate, $PublicCertificatePath))
  [void](Invoke-IntentArcCertificateStage `
    -Category 'thumbprint-verify' `
    -Operation $Commands['thumbprint-verify'] `
    -Arguments @($certificate, $PublicCertificatePath))

  $certificate
}

function Invoke-IntentArcSigningCertificateStaticSelfTest {
  $counter = [pscustomobject]@{ Value = 0 }
  $mutation = {
    $counter.Value++
    throw 'static self-test crossed a mutation boundary'
  }.GetNewClosure()
  $commands = @{
    'certificate-create' = $mutation
    'private-key-open' = { throw 'static self-test crossed a private-key boundary' }
    'certificate-export' = $mutation
    'public-certificate-export' = $mutation
    'thumbprint-verify' = { throw 'static self-test crossed a verification boundary' }
  }

  foreach ($category in $commands.Keys) {
    if ($commands[$category] -isnot [scriptblock]) {
      throw 'IntentArc signing certificate static self-test configuration invalid.'
    }
  }

  $instanceMethod = @(
    [Security.Cryptography.X509Certificates.X509Certificate2].GetMethods(
      [Reflection.BindingFlags]::Instance -bor [Reflection.BindingFlags]::Public
    ) | Where-Object { $_.Name -ceq 'GetRSAPrivateKey' }
  ).Count -gt 0
  $staticExtension = @(
    [Security.Cryptography.X509Certificates.RSACertificateExtensions].GetMethods(
      [Reflection.BindingFlags]::Static -bor [Reflection.BindingFlags]::Public
    ) | Where-Object {
      $_.Name -ceq 'GetRSAPrivateKey' -and
      $_.GetParameters().Count -eq 1 -and
      $_.GetParameters()[0].ParameterType -eq [Security.Cryptography.X509Certificates.X509Certificate2]
    }
  ).Count -eq 1

  $result = [ordered]@{
    instanceMethod = $instanceMethod
    staticExtension = $staticExtension
    mutations = $counter.Value
  }
  [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress))
}

if ($StaticSelfTest) {
  Invoke-IntentArcSigningCertificateStaticSelfTest
}
