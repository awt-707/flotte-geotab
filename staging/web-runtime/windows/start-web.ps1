param(
  [Parameter(Mandatory=$true)][string]$RuntimeRoot,
  [Parameter(Mandatory=$true)][string]$NodePath,
  [Parameter(Mandatory=$true)][string]$ConfigPath,
  [Parameter(Mandatory=$true)][string]$StateDir,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$NodeSha256,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$ManifestSha256
)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
try {
  if ((Get-FileHash -LiteralPath $NodePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $NodeSha256) { throw 'Node integrity check failed.' }
  $verify=Join-Path $RuntimeRoot 'web-runtime\verify-install.mjs'
  & $NodePath $verify --config $ConfigPath --state-dir $StateDir --manifest-sha256 $ManifestSha256 *> $null
  if ($LASTEXITCODE -ne 0) { throw 'Web integrity or configuration check failed.' }
  $log=Join-Path $StateDir 'web-service.log'
  if ((Test-Path -LiteralPath $log) -and (Get-Item -LiteralPath $log).Length -gt 65536) { Move-Item -LiteralPath $log -Destination ($log+'.previous') -Force }
  Add-Content -LiteralPath $log -Value ((Get-Date).ToUniversalTime().ToString('o')+' start')
  & $NodePath (Join-Path $RuntimeRoot 'web-runtime\main.mjs') --config $ConfigPath --state-dir $StateDir *> $null
  $exitCode=$LASTEXITCODE
  Add-Content -LiteralPath $log -Value ((Get-Date).ToUniversalTime().ToString('o')+' exit '+$exitCode)
  if ($exitCode -eq 0) { exit 0 }
  exit 1
} catch { Write-Error 'Ludy web could not start. Verify configuration, package integrity and port 4180.'; exit 1 }
