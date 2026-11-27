# Registers the "Edgeline watchdog" scheduled task (2026-11-26): at logon and
# every 15 minutes, `tools/edgeline-watchdog.vbs` runs `edgeline-up.mjs
# --watchdog`, which does nothing when Edgeline is healthy and brings back
# whatever is down otherwise. Runs as the logged-on user, in their session, so
# Docker Desktop and the worker's console start where they always have.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools/install-edgeline-watchdog.ps1
#   powershell -NoProfile -Command "Unregister-ScheduledTask -TaskName 'Edgeline watchdog' -Confirm:$false"
#
# Re-running replaces the task.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$vbs = Join-Path $PSScriptRoot 'edgeline-watchdog.vbs'
$user = "$env:USERDOMAIN\$env:USERNAME"

$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`"" -WorkingDirectory $root
$atLogon = New-ScheduledTaskTrigger -AtLogOn -User $user
$every15 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 20)
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName 'Edgeline watchdog' -Action $action -Trigger @($atLogon, $every15) `
  -Settings $settings -Principal $principal -Force `
  -Description 'Keeps Edgeline (Elasticsearch, API, worker) running and its daily backup current. app-suite/tools/edgeline-up.mjs --watchdog' | Out-Null

$task = Get-ScheduledTask -TaskName 'Edgeline watchdog'
"registered: $($task.TaskName), state $($task.State), triggers $($task.Triggers.Count)"
