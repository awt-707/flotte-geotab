param(
  [Parameter(Mandatory=$true)][string]$RuntimeRoot,
  [Parameter(Mandatory=$true)][string]$NodePath,
  [Parameter(Mandatory=$true)][string]$ConfigPath,
  [Parameter(Mandatory=$true)][string]$StateDir,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$NodeSha256,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$ManifestSha256,
  [ValidatePattern('^LudyWeb-[0-9.]+$')][string]$TaskName='LudyWeb-0.1.0'
)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$windowsPrincipal=New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $windowsPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run this installer in elevated PowerShell as the Windows account that will own Ludy web.' }
foreach ($value in @($RuntimeRoot,$NodePath,$ConfigPath,$StateDir)) {
  if (-not [IO.Path]::IsPathRooted($value) -or $value.Contains('"')) { throw 'Absolute paths without quotes are required.' }
}
function Normalize-TaskPath([string]$value) {
  $full=[IO.Path]::GetFullPath($value)
  if ($full.Equals([IO.Path]::GetPathRoot($full),[StringComparison]::OrdinalIgnoreCase)) { throw 'A dedicated directory or file is required.' }
  return $full.TrimEnd([char[]]'\/')
}
$RuntimeRoot=Normalize-TaskPath $RuntimeRoot
$NodePath=Normalize-TaskPath $NodePath
$ConfigPath=Normalize-TaskPath $ConfigPath
$StateDir=Normalize-TaskPath $StateDir
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { throw 'This Ludy web task already exists. Review it before updating.' }
if (Get-NetTCPConnection -LocalPort 4180 -State Listen -ErrorAction SilentlyContinue) { throw 'Port 4180 is already in use.' }
if ((Get-FileHash -LiteralPath $NodePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $NodeSha256) { throw 'Node integrity check failed.' }
& $NodePath (Join-Path $RuntimeRoot 'web-runtime\verify-install.mjs') --config $ConfigPath --state-dir $StateDir --manifest-sha256 $ManifestSha256
if ($LASTEXITCODE -ne 0) { throw 'Web package verification failed.' }
$wrapper=Join-Path $RuntimeRoot 'web-runtime\windows\start-web.ps1'
$entry=Join-Path $RuntimeRoot 'web-runtime\main.mjs'
$arguments='-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$wrapper+'" -RuntimeRoot "'+$RuntimeRoot+'" -NodePath "'+$NodePath+'" -ConfigPath "'+$ConfigPath+'" -StateDir "'+$StateDir+'" -NodeSha256 '+$NodeSha256+' -ManifestSha256 '+$ManifestSha256
$action=New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument $arguments -WorkingDirectory $RuntimeRoot
$principal=New-ScheduledTaskPrincipal -UserId $identity.User.Value -LogonType S4U -RunLevel Limited
$trigger=New-ScheduledTaskTrigger -AtStartup
$settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
$registered=$false
try {
  Register-ScheduledTask -TaskName $TaskName -Action $action -Principal $principal -Trigger $trigger -Settings $settings -Description 'Ludy web: independent user sessions; no collector.' | Out-Null
  $registered=$true
  Start-ScheduledTask -TaskName $TaskName
  $healthy=$false
  for ($attempt=0;$attempt -lt 35;$attempt++) {
    Start-Sleep -Seconds 1
    try {
      $response=Invoke-RestMethod -Uri 'http://127.0.0.1:4180/health' -TimeoutSec 2
      $listener=Get-NetTCPConnection -LocalPort 4180 -State Listen -ErrorAction Stop
      if (@($listener).Count -ne 1 -or $listener.LocalAddress -ne '127.0.0.1') { throw 'Unexpected listener.' }
      $process=Get-CimInstance Win32_Process -Filter ('ProcessId='+$listener.OwningProcess)
      if ($process.ExecutablePath -ne $NodePath -or -not $process.CommandLine.Contains($entry)) { throw 'Unexpected web process.' }
      if ($response.environment -eq 'production' -and $response.mode -eq 'web') { $healthy=$true; break }
    } catch {}
  }
  if (-not $healthy) { throw 'Web health check failed.' }
  [pscustomobject]@{installed=$true;task=$TaskName;port=4180;startup='S4U-Limited';collector=$false} | ConvertTo-Json -Compress
} catch {
  if ($registered) { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue }
  throw
}
