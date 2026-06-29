<#
.SYNOPSIS
  Purge any SMB session and cached credential to the SISP NAS gateway.
.DESCRIPTION
  The root cause of the lab's ownership problems is leftover SMB sessions: a previous user
  doesn't disconnect, Windows keeps the credential cached per-server, and the next user's
  writes can be attributed to the stale identity (or they hit error 1219). Running this at
  logon/logoff guarantees a clean slate. The tray app also calls the same logic before each
  connect. Safe to run repeatedly; does nothing if there is no session.
.PARAMETER Server
  Gateway host. Defaults to nas.sisp.com.
#>
param([string]$Server = 'nas.sisp.com')

if ([string]::IsNullOrWhiteSpace($Server)) { return }

# Drop all SMB connections to the gateway (covers every mapped drive + IPC$ session).
try { & "$env:SystemRoot\System32\net.exe" use "\\$Server" /delete /y *>$null } catch { }

# Remove cached Windows credentials so a stale identity is never reused.
try { & "$env:SystemRoot\System32\cmdkey.exe" "/delete:$Server" *>$null } catch { }

# Also clear any short-name / FQDN variants that may be cached separately.
$short = $Server.Split('.')[0]
if ($short -and $short -ne $Server) {
    try { & "$env:SystemRoot\System32\net.exe" use "\\$short" /delete /y *>$null } catch { }
    try { & "$env:SystemRoot\System32\cmdkey.exe" "/delete:$short" *>$null } catch { }
}
