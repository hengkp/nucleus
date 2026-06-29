<#
.SYNOPSIS
  Register a scheduled task that purges stale gateway SMB sessions at every logon.
.DESCRIPTION
  Defends shared workstations against the "previous user didn't disconnect" problem: when
  the NEXT person logs on, leftover sessions/credentials to the gateway are cleared before
  they map their drive, so their files are never written under someone else's identity.
  Pairs with the in-app pre-connect purge. Run once per machine, elevated.
.PARAMETER Server
  Gateway host (default nas.sisp.com).
.PARAMETER AllUsers
  Register for all users (machine-wide, needs admin). Default registers for the current user.
#>
param(
    [string]$Server = 'nas.sisp.com',
    [switch]$AllUsers
)

$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'Clear-GatewaySession.ps1'
if (-not (Test-Path $script)) { throw "Clear-GatewaySession.ps1 not found next to this installer." }

$taskName = 'SISP Gateway Session Cleanup'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`" -Server $Server"
# Fire on any user logon, and also when a session is unlocked (workstation handoff).
$triggers = @(New-ScheduledTaskTrigger -AtLogOn)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd -ExecutionTimeLimit (New-TimeSpan -Minutes 2)

if ($AllUsers) {
    $principal = New-ScheduledTaskPrincipal -GroupId 'S-1-5-32-545' -RunLevel Limited  # BUILTIN\Users
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $triggers -Settings $settings -Principal $principal -Force | Out-Null
    Write-Host "Registered '$taskName' for all users (logon trigger), gateway=$Server."
} else {
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $triggers -Settings $settings -Force | Out-Null
    Write-Host "Registered '$taskName' for the current user (logon trigger), gateway=$Server."
}

Write-Host "Tip: also call Clear-GatewaySession.ps1 from a Group Policy logoff script for belt-and-braces cleanup."
