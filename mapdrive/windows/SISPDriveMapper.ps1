param(
    [string]$LaunchUri = ''
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

[System.Windows.Forms.Application]::EnableVisualStyles()

$AppTitle = 'SISP MapDrive'
# Refactor (ADR-004): connect to the SISP CIFS GATEWAY (nas.sisp.com -> node2/node1), NOT
# the Infortrend NAS (192.168.0.103) directly. The gateway authenticates against OpenLDAP
# and runs as the user's real uid/gid, so file ownership is always correct and stale
# Windows sessions can no longer scramble it. nas.sisp.com is a DNS name so the client is
# decoupled from which node hosts the gateway.
$GatewayServer = 'nas.sisp.com'
$NasServer = $GatewayServer
$AssetDirectory = Join-Path $PSScriptRoot 'assets'
$AppIconPath = Join-Path $AssetDirectory 'app-icon.ico'
$TrayIconDirectory = Join-Path $AssetDirectory 'tray-icons'
$SettingsDirectory = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'SISPDriveMapper'
$SettingsPath = Join-Path $SettingsDirectory 'settings.json'
$DefaultShare = "\\$GatewayServer\sisplockers"
$SharePresets = @(
    "\\$GatewayServer\sisplockers",
    "\\$GatewayServer\shared",
    "\\$GatewayServer\research",
    "\\$GatewayServer\CRCproject",
    "\\$GatewayServer\admin_dept",
    "\\$GatewayServer\admin_sp",
    "\\$GatewayServer\filing",
    "\\$GatewayServer\hr",
    "\\$GatewayServer\postgraduate",
    "\\$GatewayServer\purchasing",
    "\\$GatewayServer\undergraduate"
)
$SharePresets = @($SharePresets | Sort-Object -Unique)
# The gateway authenticates against OpenLDAP: sign in with your PLAIN lab username (no
# SIRIRAJ\ domain prefix).
$DefaultDomain = ''
$DefaultDrive = 'Z:'
$DefaultUsername = ''
$DefaultLoginFormat = 'username only'
$script:LaunchOptions = @{}
$script:MappingUsers = @{}

function ConvertFrom-LaunchUri {
    param([string]$RawUri)

    $options = @{}
    if ([string]::IsNullOrWhiteSpace($RawUri)) {
        return $options
    }

    $query = $RawUri
    try {
        $uri = [System.Uri]$RawUri
        $query = $uri.Query
    }
    catch {
    }

    if ([string]::IsNullOrWhiteSpace($query)) {
        return $options
    }

    $query = $query.TrimStart('?')
    foreach ($pair in $query.Split('&')) {
        if ([string]::IsNullOrWhiteSpace($pair)) {
            continue
        }

        $parts = $pair.Split('=', 2)
        $key = [System.Uri]::UnescapeDataString($parts[0]).Trim().ToLowerInvariant()
        if ([string]::IsNullOrWhiteSpace($key)) {
            continue
        }

        $value = ''
        if ($parts.Count -gt 1) {
            $value = [System.Uri]::UnescapeDataString($parts[1])
        }

        $options[$key] = $value
    }

    return $options
}

function Get-LaunchOption {
    param(
        [string]$Name,
        [string]$Fallback = ''
    )

    $key = $Name.ToLowerInvariant()
    if ($script:LaunchOptions.ContainsKey($key)) {
        return [string]$script:LaunchOptions[$key]
    }

    return $Fallback
}

function Get-QualifiedUsername {
    param(
        [string]$Username,
        [string]$Domain,
        [string]$LoginFormat
    )

    $cleanUser = $Username.Trim()
    if ($cleanUser -match '\\' -or $cleanUser -match '@') {
        return $cleanUser
    }

    if ($LoginFormat -eq 'username@siriraj.local') {
        return "$cleanUser@siriraj.local"
    }

    if ($LoginFormat -eq 'username only') {
        return $cleanUser
    }

    $cleanDomain = $Domain.Trim()
    if ($cleanDomain.Length -gt 0) {
        return "$cleanDomain\$cleanUser"
    }

    # Gateway authenticates against OpenLDAP, so default to the bare username, not a domain.
    return $cleanUser
}

function Get-ShareServer {
    param([string]$SharePath)

    if ($SharePath -match '^\\\\([^\\]+)\\') {
        return $Matches[1]
    }

    return $null
}

function Clear-GatewaySession {
    # Root-cause fix for stale-session ownership drift (ADR-004, client side). Before we map,
    # drop ANY existing SMB session and cached credential to the gateway server, so a previous
    # user who didn't disconnect can't cause error 1219 or have their identity reused for the
    # new user's writes.
    param([string]$Server)

    if ([string]::IsNullOrWhiteSpace($Server)) {
        return
    }

    try { & "$env:SystemRoot\System32\net.exe" use "\\$Server" /delete /y *>$null } catch { }
    try { & "$env:SystemRoot\System32\cmdkey.exe" "/delete:$Server" *>$null } catch { }
}

function Get-NormalizedDriveId {
    param([string]$Drive)

    if ([string]::IsNullOrWhiteSpace($Drive)) {
        return ''
    }

    if ($Drive -match '^([A-Za-z]):') {
        return $Matches[1].ToUpperInvariant() + ':'
    }

    return $Drive.Trim().ToUpperInvariant()
}

function Get-NormalizedUncPath {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return ''
    }

    return $Path.Trim().TrimEnd('\').ToLowerInvariant()
}

function Get-DriveInfo {
    param([string]$Drive)

    $deviceId = $Drive.TrimEnd(':') + ':'
    try {
        return Get-CimInstance Win32_LogicalDisk -Filter ("DeviceID='{0}'" -f $deviceId) -ErrorAction SilentlyContinue
    }
    catch {
        return $null
    }
}

function Import-MappingUserTable {
    param($Value)

    $table = @{}
    if ($null -eq $Value) {
        return $table
    }

    if ($Value -is [System.Collections.IDictionary]) {
        foreach ($key in $Value.Keys) {
            $drive = Get-NormalizedDriveId -Drive ([string]$key)
            if ([string]::IsNullOrWhiteSpace($drive)) {
                continue
            }

            $record = $Value[$key]
            $table[$drive] = [pscustomobject]@{
                RemotePath = [string]$record.RemotePath
                UserName = [string]$record.UserName
                UpdatedAt = [string]$record.UpdatedAt
            }
        }

        return $table
    }

    foreach ($property in $Value.PSObject.Properties) {
        $drive = Get-NormalizedDriveId -Drive ([string]$property.Name)
        if ([string]::IsNullOrWhiteSpace($drive)) {
            continue
        }

        $record = $property.Value
        $table[$drive] = [pscustomobject]@{
            RemotePath = [string]$record.RemotePath
            UserName = [string]$record.UserName
            UpdatedAt = [string]$record.UpdatedAt
        }
    }

    return $table
}

function Get-NetworkConnectionLookup {
    $lookup = @{}

    try {
        Get-CimInstance Win32_NetworkConnection -ErrorAction Stop | Where-Object {
            $_.LocalName -match '^[A-Za-z]:$'
        } | ForEach-Object {
            $drive = Get-NormalizedDriveId -Drive ([string]$_.LocalName)
            $status = [string]$_.ConnectionState
            if ([string]::IsNullOrWhiteSpace($status)) {
                $status = [string]$_.Status
            }
            if ([string]::IsNullOrWhiteSpace($status)) {
                $status = 'Mapped'
            }

            $lookup[$drive] = [pscustomobject]@{
                RemotePath = [string]$_.RemoteName
                UserName = [string]$_.UserName
                Status = $status
            }
        }
    }
    catch {
    }

    return $lookup
}

function Get-RegistryMappingLookup {
    $lookup = @{}
    $networkRoot = 'Registry::HKEY_CURRENT_USER\Network'

    if (-not (Test-Path -LiteralPath $networkRoot)) {
        return $lookup
    }

    try {
        Get-ChildItem -LiteralPath $networkRoot -ErrorAction Stop | Where-Object {
            $_.PSChildName -match '^[A-Za-z]$'
        } | ForEach-Object {
            $drive = (Get-NormalizedDriveId -Drive ($_.PSChildName + ':'))
            $properties = Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue
            if ($null -eq $properties) {
                return
            }

            $lookup[$drive] = [pscustomobject]@{
                RemotePath = [string]$properties.RemotePath
                UserName = [string]$properties.UserName
                Status = 'Mapped'
            }
        }
    }
    catch {
    }

    return $lookup
}

function Test-MappingRecordMatches {
    param(
        $Record,
        [string]$RemotePath
    )

    if ($null -eq $Record) {
        return $false
    }

    if ([string]::IsNullOrWhiteSpace([string]$Record.RemotePath) -or [string]::IsNullOrWhiteSpace($RemotePath)) {
        return $true
    }

    return (Get-NormalizedUncPath -Path ([string]$Record.RemotePath)) -eq (Get-NormalizedUncPath -Path $RemotePath)
}

function Resolve-MappingUserName {
    param(
        [string]$LocalPath,
        [string]$RemotePath,
        [string]$ReportedUserName,
        [hashtable]$NetworkLookup,
        [hashtable]$RegistryLookup
    )

    if (-not [string]::IsNullOrWhiteSpace($ReportedUserName)) {
        return $ReportedUserName
    }

    $drive = Get-NormalizedDriveId -Drive $LocalPath
    foreach ($lookup in @($NetworkLookup, $RegistryLookup, $script:MappingUsers)) {
        if ($null -eq $lookup -or -not $lookup.ContainsKey($drive)) {
            continue
        }

        $record = $lookup[$drive]
        if ((Test-MappingRecordMatches -Record $record -RemotePath $RemotePath) -and -not [string]::IsNullOrWhiteSpace([string]$record.UserName)) {
            return [string]$record.UserName
        }
    }

    $remoteServer = Get-ShareServer -SharePath $RemotePath
    if ($remoteServer -and $remoteServer.ToLowerInvariant() -eq $NasServer.ToLowerInvariant()) {
        if (-not [string]::IsNullOrWhiteSpace([string]$script:AppSettings.LastQualifiedUsername)) {
            return [string]$script:AppSettings.LastQualifiedUsername
        }
    }

    return ''
}

function Get-CurrentMappings {
    $items = @()
    $networkLookup = Get-NetworkConnectionLookup
    $registryLookup = Get-RegistryMappingLookup

    if (Get-Command Get-SmbMapping -ErrorAction SilentlyContinue) {
        try {
            $items = Get-SmbMapping -ErrorAction Stop | Where-Object { $_.LocalPath -match '^[A-Z]:$' } | ForEach-Object {
                $status = $_.Status
                if ($null -eq $status -or [string]::IsNullOrWhiteSpace([string]$status)) {
                    $status = 'Mapped'
                }

                [pscustomobject]@{
                    LocalPath = [string]$_.LocalPath
                    RemotePath = [string]$_.RemotePath
                    UserName = Resolve-MappingUserName -LocalPath ([string]$_.LocalPath) -RemotePath ([string]$_.RemotePath) -ReportedUserName ([string]$_.UserName) -NetworkLookup $networkLookup -RegistryLookup $registryLookup
                    Status = [string]$status
                }
            }
        }
        catch {
            $items = @()
        }
    }

    if ($items.Count -eq 0) {
        $items = @($networkLookup.Keys | Sort-Object | ForEach-Object {
            $record = $networkLookup[$_]
            [pscustomobject]@{
                LocalPath = [string]$_
                RemotePath = [string]$record.RemotePath
                UserName = Resolve-MappingUserName -LocalPath ([string]$_) -RemotePath ([string]$record.RemotePath) -ReportedUserName ([string]$record.UserName) -NetworkLookup $networkLookup -RegistryLookup $registryLookup
                Status = (Get-DisplayText $record.Status 'Mapped')
            }
        })
    }

    if ($items.Count -eq 0) {
        try {
            $items = Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=4' -ErrorAction Stop | ForEach-Object {
                [pscustomobject]@{
                    LocalPath = [string]$_.DeviceID
                    RemotePath = [string]$_.ProviderName
                    UserName = Resolve-MappingUserName -LocalPath ([string]$_.DeviceID) -RemotePath ([string]$_.ProviderName) -ReportedUserName '' -NetworkLookup $networkLookup -RegistryLookup $registryLookup
                    Status = 'Mapped'
                }
            }
        }
        catch {
            $items = @()
        }
    }

    return @($items | Sort-Object LocalPath)
}

function Get-DisplayText {
    param(
        $Value,
        [string]$Fallback = ''
    )

    if ($null -eq $Value) {
        return $Fallback
    }

    $text = [string]$Value
    if ([string]::IsNullOrWhiteSpace($text)) {
        return $Fallback
    }

    return $text
}

function Get-DriveTypeName {
    param([int]$DriveType)

    switch ($DriveType) {
        2 { return 'removable drive' }
        3 { return 'local drive' }
        4 { return 'network drive' }
        5 { return 'CD/DVD drive' }
        6 { return 'RAM disk' }
        default { return "drive type $DriveType" }
    }
}

function Get-DriveDisplayText {
    param([string]$Drive)

    $deviceId = $Drive.TrimEnd(':') + ':'
    $existing = Get-DriveInfo -Drive $deviceId

    if ($null -eq $existing) {
        return $deviceId
    }

    if ($existing.DriveType -eq 4) {
        $provider = $existing.ProviderName
        if ([string]::IsNullOrWhiteSpace($provider)) {
            $provider = 'network share'
        }
        return "$deviceId - $provider"
    }

    $label = $existing.VolumeName
    if ($deviceId -eq $env:SystemDrive) {
        $label = 'System'
    }
    elseif ([string]::IsNullOrWhiteSpace($label)) {
        $label = Get-DriveTypeName -DriveType $existing.DriveType
    }

    return "$deviceId - $label"
}

function Get-ServerMappings {
    param([string]$Server)

    if ([string]::IsNullOrWhiteSpace($Server)) {
        return @()
    }

    return @(Get-CurrentMappings | Where-Object {
        $remoteServer = Get-ShareServer -SharePath $_.RemotePath
        $remoteServer -and ($remoteServer.ToLowerInvariant() -eq $Server.ToLowerInvariant())
    })
}

function Get-SispMappings {
    return @(Get-ServerMappings -Server $NasServer)
}

function Get-TrayStatus {
    $mappings = @(Get-SispMappings)
    if ($mappings.Count -eq 0) {
        return 'Disconnected'
    }

    return 'Connected'
}

function Get-NotifyText {
    $mappings = @(Get-SispMappings)
    if ($mappings.Count -eq 0) {
        return 'SISP NAS: not connected'
    }

    $users = @($mappings | Where-Object { -not [string]::IsNullOrWhiteSpace($_.UserName) } | Select-Object -ExpandProperty UserName -Unique)
    if ($users.Count -eq 1) {
        $text = "SISP NAS: $($users[0]) ($($mappings.Count) drive(s))"
    }
    elseif ($users.Count -gt 1) {
        $text = "SISP NAS: $($users.Count) users, $($mappings.Count) drives"
    }
    elseif (-not [string]::IsNullOrWhiteSpace($script:AppSettings.LastUsername)) {
        $text = "SISP NAS: $($script:AppSettings.LastUsername) ($($mappings.Count) drive(s))"
    }
    else {
        $text = "SISP NAS: connected ($($mappings.Count) drive(s))"
    }

    if ($text.Length -gt 63) {
        return $text.Substring(0, 60) + '...'
    }

    return $text
}

function Get-SelectedDrive {
    $selected = [string]$driveBox.SelectedItem
    if ([string]::IsNullOrWhiteSpace($selected)) {
        $selected = $driveBox.Text
    }

    if ($selected -match '^([A-Z]:)') {
        return $Matches[1]
    }

    return $DefaultDrive
}

function Refresh-DriveList {
    param([string]$PreferredDrive)

    if ([string]::IsNullOrWhiteSpace($PreferredDrive)) {
        $PreferredDrive = Get-SelectedDrive
    }

    $PreferredDrive = $PreferredDrive.TrimEnd(':') + ':'
    $selectedText = $null
    $driveBox.BeginUpdate()
    try {
        $driveBox.Items.Clear()
        67..90 | ForEach-Object {
            $drive = ([char]$_) + ':'
            $display = Get-DriveDisplayText -Drive $drive
            [void]$driveBox.Items.Add($display)
            if ($drive -eq $PreferredDrive) {
                $selectedText = $display
            }
        }

        if ($null -ne $selectedText) {
            $driveBox.SelectedItem = $selectedText
        }
        elseif ($driveBox.Items.Count -gt 0) {
            $driveBox.SelectedIndex = 0
        }
    }
    finally {
        $driveBox.EndUpdate()
    }
}

function Select-DriveBoxDrive {
    param([string]$Drive)

    if ($null -eq $driveBox -or [string]::IsNullOrWhiteSpace($Drive)) {
        return
    }

    $driveId = $Drive.TrimEnd(':').ToUpperInvariant() + ':'
    foreach ($item in $driveBox.Items) {
        $text = [string]$item
        if ($text -match '^([A-Z]:)' -and $Matches[1] -eq $driveId) {
            $driveBox.SelectedItem = $item
            return
        }
    }
}

function Get-SelectedMapping {
    if ($null -eq $mappingList -or $mappingList.SelectedItems.Count -eq 0) {
        return $null
    }

    return $mappingList.SelectedItems[0].Tag
}

function Get-SelectedMappingDrive {
    $mapping = Get-SelectedMapping
    if ($null -eq $mapping) {
        return $null
    }

    $drive = [string]$mapping.LocalPath
    if ($drive -match '^[A-Z]:$') {
        return $drive
    }

    return $null
}

# Drives whose checkbox is ticked in the mounted-drives list (multi-select disconnect).
function Get-CheckedMappingDrives {
    $drives = @()
    if ($null -ne $mappingList) {
        foreach ($it in $mappingList.CheckedItems) {
            $m = $it.Tag
            if ($null -ne $m) {
                $d = [string]$m.LocalPath
                if ($d -match '^[A-Z]:$') { $drives += $d }
            }
        }
    }
    return $drives
}

function Update-MappingActionButtons {
    if ($null -ne $disconnectButton) {
        $disconnectButton.Enabled = ($null -ne $mappingList -and $mappingList.CheckedItems.Count -gt 0)
    }
}

function New-NetworkObject {
    return New-Object -ComObject WScript.Network
}

function Show-Info {
    param([string]$Message)
    [System.Windows.Forms.MessageBox]::Show($Message, $AppTitle, 'OK', 'Information') | Out-Null
}

function Show-Warning {
    param([string]$Message)
    [System.Windows.Forms.MessageBox]::Show($Message, $AppTitle, 'OK', 'Warning') | Out-Null
}

function Test-MappedDriveAccess {
    param([string]$Drive)

    $path = $Drive.TrimEnd(':') + ':\'
    try {
        [void](Get-ChildItem -LiteralPath $path -Force -ErrorAction Stop | Select-Object -First 1)
        return [pscustomobject]@{ Success = $true; Message = '' }
    }
    catch {
        return [pscustomobject]@{ Success = $false; Message = $_.Exception.Message }
    }
}

function Write-Status {
    param(
        [System.Windows.Forms.TextBox]$Box,
        [string]$Message
    )

    $timestamp = Get-Date -Format 'HH:mm:ss'
    $Box.AppendText("[$timestamp] $Message`r`n")
}

function Read-AppSettings {
    if (-not (Test-Path $SettingsPath)) {
        return [pscustomobject]@{}
    }

    try {
        return Get-Content -Raw -Path $SettingsPath | ConvertFrom-Json
    }
    catch {
        return [pscustomobject]@{}
    }
}

function Remember-SharePath {
    param([string]$SharePath)

    $cleanShare = $SharePath.Trim()
    if ($cleanShare -notmatch '^\\\\[^\\]+\\[^\\]+') {
        return
    }

    $known = @($script:SharePresets | ForEach-Object { $_.ToLowerInvariant() })
    if ($known -notcontains $cleanShare.ToLowerInvariant()) {
        $script:SharePresets = @($script:SharePresets + $cleanShare | Sort-Object -Unique)
        if ($null -ne $shareBox) {
            [void]$shareBox.Items.Add($cleanShare)
        }
    }
}

function Set-MappingUserInfo {
    param(
        [string]$Drive,
        [string]$RemotePath,
        [string]$UserName
    )

    $driveId = Get-NormalizedDriveId -Drive $Drive
    if ([string]::IsNullOrWhiteSpace($driveId) -or [string]::IsNullOrWhiteSpace($UserName)) {
        return
    }

    $script:MappingUsers[$driveId] = [pscustomobject]@{
        RemotePath = $RemotePath
        UserName = $UserName
        UpdatedAt = (Get-Date).ToString('s')
    }
}

function Remove-MappingUserInfo {
    param([string]$Drive)

    $driveId = Get-NormalizedDriveId -Drive $Drive
    if (-not [string]::IsNullOrWhiteSpace($driveId) -and $script:MappingUsers.ContainsKey($driveId)) {
        $script:MappingUsers.Remove($driveId)
    }
}

function Save-CurrentSettings {
    if ($null -eq $shareBox -or $null -eq $driveBox -or $null -eq $domainBox -or $null -eq $userBox -or $null -eq $loginFormatBox) {
        return
    }

    $share = $shareBox.Text.Trim()
    Remember-SharePath -SharePath $share
    $username = $userBox.Text.Trim()
    $loginFormat = [string]$loginFormatBox.SelectedItem
    $qualifiedUsername = ''
    if (-not [string]::IsNullOrWhiteSpace($username)) {
        $qualifiedUsername = Get-QualifiedUsername -Username $username -Domain $domainBox.Text -LoginFormat $loginFormat
    }

    try {
        if (-not (Test-Path $SettingsDirectory)) {
            [void](New-Item -ItemType Directory -Path $SettingsDirectory -Force)
        }

        $script:AppSettings = [pscustomobject]@{
            LastShare = $share
            LastDrive = Get-SelectedDrive
            LastDomain = $domainBox.Text.Trim()
            LastUsername = $username
            LastQualifiedUsername = $qualifiedUsername
            LastLoginFormat = $loginFormat
            MappingUsers = $script:MappingUsers
            SharePresets = @($script:SharePresets | Sort-Object -Unique)
            UpdatedAt = (Get-Date).ToString('s')
        }

        $script:AppSettings | ConvertTo-Json -Depth 4 | Set-Content -Path $SettingsPath -Encoding UTF8
    }
    catch {
        Write-Status $statusBox "Could not save settings: $($_.Exception.Message)"
    }
}

function Apply-AppSettings {
    $script:AppSettings = Read-AppSettings
    $script:MappingUsers = Import-MappingUserTable -Value $script:AppSettings.MappingUsers

    foreach ($savedShare in @($script:AppSettings.SharePresets)) {
        if (-not [string]::IsNullOrWhiteSpace($savedShare)) {
            Remember-SharePath -SharePath ([string]$savedShare)
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($script:AppSettings.LastShare)) {
        $script:DefaultShare = [string]$script:AppSettings.LastShare
        Remember-SharePath -SharePath $script:DefaultShare
    }

    if (-not [string]::IsNullOrWhiteSpace($script:AppSettings.LastDrive)) {
        $script:DefaultDrive = ([string]$script:AppSettings.LastDrive).TrimEnd(':') + ':'
    }

    if (-not [string]::IsNullOrWhiteSpace($script:AppSettings.LastLoginFormat)) {
        $script:DefaultLoginFormat = [string]$script:AppSettings.LastLoginFormat
    }

    if (-not [string]::IsNullOrWhiteSpace($script:AppSettings.LastDomain)) {
        $savedDomain = [string]$script:AppSettings.LastDomain
        if ($savedDomain -ieq 'siriraj.local' -and [string]::IsNullOrWhiteSpace($script:AppSettings.LastLoginFormat)) {
            $savedDomain = 'SIRIRAJ'
            $script:DefaultLoginFormat = 'SIRIRAJ\username'
        }
        $script:DefaultDomain = $savedDomain
    }

    if (-not [string]::IsNullOrWhiteSpace($script:AppSettings.LastUsername)) {
        $script:DefaultUsername = [string]$script:AppSettings.LastUsername
    }
}

function Apply-LaunchOptions {
    $share = Get-LaunchOption -Name 'share'
    if ($share -match '^\\\\[^\\]+\\[^\\]+') {
        $script:DefaultShare = $share
        Remember-SharePath -SharePath $share
    }

    $drive = Get-LaunchOption -Name 'drive'
    if ($drive -match '^[A-Za-z]:?$') {
        $script:DefaultDrive = $drive.TrimEnd(':').ToUpperInvariant() + ':'
    }

    $username = Get-LaunchOption -Name 'username'
    if (-not [string]::IsNullOrWhiteSpace($username)) {
        $script:DefaultUsername = $username.Trim()
    }

    $domain = Get-LaunchOption -Name 'domain'
    if (-not [string]::IsNullOrWhiteSpace($domain)) {
        $script:DefaultDomain = $domain.Trim()
    }

    $loginFormat = Get-LaunchOption -Name 'login'
    switch ($loginFormat.ToLowerInvariant()) {
        'domain' { $script:DefaultLoginFormat = 'SIRIRAJ\username'; $script:DefaultDomain = 'SIRIRAJ' }
        'upn' { $script:DefaultLoginFormat = 'username@siriraj.local'; $script:DefaultDomain = 'siriraj.local' }
        'plain' { $script:DefaultLoginFormat = 'username only' }
        'siriraj\username' { $script:DefaultLoginFormat = 'SIRIRAJ\username'; $script:DefaultDomain = 'SIRIRAJ' }
        'username@siriraj.local' { $script:DefaultLoginFormat = 'username@siriraj.local'; $script:DefaultDomain = 'siriraj.local' }
        'username only' { $script:DefaultLoginFormat = 'username only' }
    }
}

function Test-DarkTaskbar {
    # Windows 11 taskbar/tray colour follows SystemUsesLightTheme: 1 = light taskbar,
    # 0 = dark taskbar. The disconnected glyph is monochrome, so we ship a dark version
    # for a light taskbar and a light version for a dark taskbar. Default to light taskbar
    # (dark glyph) when the key is missing, since that is the common case.
    try {
        $v = Get-ItemPropertyValue -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' -Name 'SystemUsesLightTheme' -ErrorAction Stop
        return ($v -eq 0)
    }
    catch {
        return $false
    }
}

function Get-TrayIconAssetPath {
    param([string]$Status)

    $fileName = switch ($Status) {
        'Connected' { 'connected.ico' }
        'Disconnected' {
            # Colourful "connected" reads on either taskbar; the monochrome "disconnected"
            # glyph needs a light variant on a dark taskbar so it stays visible.
            if (Test-DarkTaskbar) { 'disconnected-darktheme.ico' } else { 'disconnected.ico' }
        }
        default { '' }
    }

    if ([string]::IsNullOrWhiteSpace($fileName)) {
        return ''
    }

    return Join-Path $TrayIconDirectory $fileName
}

function New-SispTrayIcon {
    param([string]$Status = 'Disconnected')

    $trayIconPath = Get-TrayIconAssetPath -Status $Status
    if (-not [string]::IsNullOrWhiteSpace($trayIconPath) -and (Test-Path -LiteralPath $trayIconPath)) {
        try {
            # Request a generous 32px frame so the tray renders the icon FULL size (crisp on
            # high-DPI), instead of pinning to a tiny padded 16px frame. Windows scales it to the
            # notification-area slot. Pair this with full-bleed icon art for best results.
            return (New-Object System.Drawing.Icon -ArgumentList $trayIconPath, 32, 32)
        }
        catch {
            try { return New-Object System.Drawing.Icon -ArgumentList $trayIconPath } catch { }
        }
    }

    $bitmap = New-Object System.Drawing.Bitmap 16, 16
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.Clear([System.Drawing.Color]::Transparent)

    $background = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(17, 105, 95))
    $graphics.FillEllipse($background, 1, 1, 14, 14)

    $font = New-Object System.Drawing.Font('Segoe UI', 9, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $textBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
    $format = New-Object System.Drawing.StringFormat
    $format.Alignment = [System.Drawing.StringAlignment]::Center
    $format.LineAlignment = [System.Drawing.StringAlignment]::Center
    $graphics.DrawString('S', $font, $textBrush, (New-Object System.Drawing.RectangleF(0, 0, 16, 15)), $format)

    switch ($Status) {
        'Connected' { $dotColor = [System.Drawing.Color]::FromArgb(46, 155, 95) }
        'Warning' { $dotColor = [System.Drawing.Color]::FromArgb(182, 121, 31) }
        default { $dotColor = [System.Drawing.Color]::FromArgb(140, 140, 140) }
    }
    $dotBorder = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
    $dotBrush = New-Object System.Drawing.SolidBrush $dotColor
    $graphics.FillEllipse($dotBorder, 9, 9, 7, 7)
    $graphics.FillEllipse($dotBrush, 10, 10, 5, 5)

    $icon = [System.Drawing.Icon]::FromHandle($bitmap.GetHicon())
    $graphics.Dispose()
    $background.Dispose()
    $font.Dispose()
    $textBrush.Dispose()
    $dotBorder.Dispose()
    $dotBrush.Dispose()
    $format.Dispose()
    $bitmap.Dispose()

    return $icon
}

function Get-ApplicationIcon {
    if (Test-Path -LiteralPath $AppIconPath) {
        try {
            return New-Object System.Drawing.Icon -ArgumentList $AppIconPath
        }
        catch {
        }
    }

    return New-SispTrayIcon
}

function Update-MappingView {
    param([string]$PreferredDrive = '')

    $mappings = @(Get-CurrentMappings)

    if ($null -ne $mappingList) {
        $selectedDrive = Get-SelectedMappingDrive
        if ([string]::IsNullOrWhiteSpace($PreferredDrive)) {
            $PreferredDrive = $selectedDrive
        }
        if (-not [string]::IsNullOrWhiteSpace($PreferredDrive)) {
            $PreferredDrive = $PreferredDrive.TrimEnd(':').ToUpperInvariant() + ':'
        }

        $mappingList.BeginUpdate()
        try {
            $mappingList.Items.Clear()

            if ($mappings.Count -eq 0) {
                $item = New-Object System.Windows.Forms.ListViewItem('None')
                [void]$item.SubItems.Add('')
                [void]$item.SubItems.Add('')
                [void]$item.SubItems.Add('No mapped network drives')
                $item.ForeColor = [System.Drawing.Color]::FromArgb(105, 119, 132)
                [void]$mappingList.Items.Add($item)
            }
            else {
                foreach ($mapping in $mappings) {
                    $item = New-Object System.Windows.Forms.ListViewItem((Get-DisplayText $mapping.LocalPath ''))
                    [void]$item.SubItems.Add((Get-DisplayText $mapping.RemotePath ''))
                    [void]$item.SubItems.Add((Get-DisplayText $mapping.UserName '(not reported)'))
                    [void]$item.SubItems.Add((Get-DisplayText $mapping.Status 'Mapped'))
                    $item.Tag = $mapping
                    [void]$mappingList.Items.Add($item)
                    if (-not [string]::IsNullOrWhiteSpace($PreferredDrive) -and ([string]$mapping.LocalPath).ToUpperInvariant() -eq $PreferredDrive) {
                        $item.Selected = $true
                        $item.Focused = $true
                        $item.EnsureVisible()
                    }
                }
            }
        }
        finally {
            $mappingList.EndUpdate()
        }

        Update-MappingActionButtons
    }

    if ($null -ne $notifyIcon) {
        $notifyIcon.Text = Get-NotifyText
        $oldIcon = $notifyIcon.Icon
        $notifyIcon.Icon = New-SispTrayIcon -Status (Get-TrayStatus)
        if ($null -ne $oldIcon) {
            $oldIcon.Dispose()
        }
    }

    if ($null -ne $trayStatusItem) {
        $trayStatusItem.Text = Get-NotifyText
    }
}

function Set-TrayBusy {
    # Only two tray states now (connected / disconnected). While a map/unmap is in flight just
    # update the tooltip; DoEvents() forces a repaint before the blocking call. refresh() sets
    # the final connected/disconnected icon afterwards.
    param([string]$Message = 'working...')

    if ($null -eq $notifyIcon) {
        return
    }

    $notifyIcon.Text = "$AppTitle`: $Message"
    [System.Windows.Forms.Application]::DoEvents()
}

function Show-TrayNotification {
    param(
        [string]$Message,
        [string]$Icon = 'Info'
    )

    if ($null -eq $notifyIcon) {
        return
    }

    try {
        $notifyIcon.ShowBalloonTip(2500, $AppTitle, $Message, $Icon)
    }
    catch {
    }
}

function Show-MainWindow {
    Update-MappingView
    Refresh-DriveList -PreferredDrive (Get-SelectedDrive)
    if (-not $form.Visible) {
        $form.Show()
    }
    if ($form.WindowState -eq [System.Windows.Forms.FormWindowState]::Minimized) {
        $form.WindowState = [System.Windows.Forms.FormWindowState]::Normal
    }
    $form.Activate()
}

$script:ExitRequested = $false
$script:LaunchOptions = ConvertFrom-LaunchUri -RawUri $LaunchUri

Apply-AppSettings
Apply-LaunchOptions

# SISP MapDrive palette, shares the AppHub design tokens (teal heritage).
# brand #11695f / brand-strong #0c4f47 / ink #131a19 / muted #5d6b68 /
# surface #fff / surface-alt #f1f5f4 / bg #f7f9f9 / border #dce4e2 / danger #c0392b.
$ColorBackground = [System.Drawing.Color]::FromArgb(247, 249, 249)
$ColorSurface = [System.Drawing.Color]::FromArgb(255, 255, 255)
$ColorSurfaceAlt = [System.Drawing.Color]::FromArgb(241, 245, 244)
$ColorLine = [System.Drawing.Color]::FromArgb(220, 228, 226)
$ColorInk = [System.Drawing.Color]::FromArgb(19, 26, 25)
$ColorMuted = [System.Drawing.Color]::FromArgb(93, 107, 104)
$ColorOcean = [System.Drawing.Color]::FromArgb(12, 79, 71)   # brand-strong
$ColorCyan = [System.Drawing.Color]::FromArgb(17, 105, 95)   # brand teal
$ColorTint = [System.Drawing.Color]::FromArgb(226, 241, 238) # brand-tint
$ColorGreen = [System.Drawing.Color]::FromArgb(46, 155, 95)  # connected
$ColorDanger = [System.Drawing.Color]::FromArgb(192, 57, 43)

function Set-ButtonStyle {
    param(
        [System.Windows.Forms.Button]$Button,
        [System.Drawing.Color]$BackColor,
        [System.Drawing.Color]$ForeColor
    )

    $Button.FlatStyle = 'Flat'
    $Button.FlatAppearance.BorderSize = 1
    $Button.FlatAppearance.BorderColor = $ColorLine
    $Button.BackColor = $BackColor
    $Button.ForeColor = $ForeColor
    $Button.Font = New-Object System.Drawing.Font('Segoe UI', 9, [System.Drawing.FontStyle]::Bold)
    $Button.Cursor = [System.Windows.Forms.Cursors]::Hand
}

$form = New-Object System.Windows.Forms.Form
$form.Text = $AppTitle
$form.StartPosition = 'CenterScreen'
$form.Size = New-Object System.Drawing.Size(880, 724)
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.Font = New-Object System.Drawing.Font('Segoe UI', 9)
$form.Icon = Get-ApplicationIcon
$form.BackColor = $ColorBackground

# ----- Header band -----
$headerPanel = New-Object System.Windows.Forms.Panel
$headerPanel.Location = New-Object System.Drawing.Point(0, 0)
$headerPanel.Size = New-Object System.Drawing.Size(880, 80)
$headerPanel.BackColor = $ColorSurface
$form.Controls.Add($headerPanel)

$headerAccent = New-Object System.Windows.Forms.Panel
$headerAccent.Location = New-Object System.Drawing.Point(0, 0)
$headerAccent.Size = New-Object System.Drawing.Size(880, 4)
$headerAccent.BackColor = $ColorCyan
$headerPanel.Controls.Add($headerAccent)

$headerRule = New-Object System.Windows.Forms.Panel
$headerRule.Location = New-Object System.Drawing.Point(0, 79)
$headerRule.Size = New-Object System.Drawing.Size(880, 1)
$headerRule.BackColor = $ColorLine
$headerPanel.Controls.Add($headerRule)

if (Test-Path -LiteralPath (Join-Path $AssetDirectory 'app-icon.png')) {
    $headerImage = New-Object System.Windows.Forms.PictureBox
    $headerImage.Location = New-Object System.Drawing.Point(24, 17)
    $headerImage.Size = New-Object System.Drawing.Size(46, 46)
    $headerImage.SizeMode = 'Zoom'
    $headerImage.Image = [System.Drawing.Image]::FromFile((Join-Path $AssetDirectory 'app-icon.png'))
    $headerPanel.Controls.Add($headerImage)
}

$title = New-Object System.Windows.Forms.Label
$title.Text = 'SISP MapDrive'
$title.Font = New-Object System.Drawing.Font('Segoe UI', 16, [System.Drawing.FontStyle]::Bold)
$title.ForeColor = $ColorInk
$title.Location = New-Object System.Drawing.Point(82, 15)
$title.Size = New-Object System.Drawing.Size(380, 30)
$headerPanel.Controls.Add($title)

$subtitle = New-Object System.Windows.Forms.Label
$subtitle.Text = 'Map and manage your lab network drives'
$subtitle.Font = New-Object System.Drawing.Font('Segoe UI', 9)
$subtitle.ForeColor = $ColorMuted
$subtitle.Location = New-Object System.Drawing.Point(84, 47)
$subtitle.Size = New-Object System.Drawing.Size(460, 20)
$headerPanel.Controls.Add($subtitle)

$statusPill = New-Object System.Windows.Forms.Label
$statusPill.Text = "Gateway $GatewayServer"
$statusPill.Font = New-Object System.Drawing.Font('Segoe UI', 9, [System.Drawing.FontStyle]::Bold)
$statusPill.ForeColor = $ColorOcean
$statusPill.BackColor = $ColorSurfaceAlt
$statusPill.TextAlign = 'MiddleCenter'
$statusPill.Location = New-Object System.Drawing.Point(686, 24)
$statusPill.Size = New-Object System.Drawing.Size(172, 32)
$headerPanel.Controls.Add($statusPill)

# ----- Connect card -----
$connectPanel = New-Object System.Windows.Forms.Panel
$connectPanel.Location = New-Object System.Drawing.Point(20, 96)
$connectPanel.Size = New-Object System.Drawing.Size(840, 260)
$connectPanel.BackColor = $ColorSurface
$connectPanel.BorderStyle = 'FixedSingle'
$form.Controls.Add($connectPanel)

$connectHeading = New-Object System.Windows.Forms.Label
$connectHeading.Text = 'Connect a drive'
$connectHeading.Font = New-Object System.Drawing.Font('Segoe UI', 11, [System.Drawing.FontStyle]::Bold)
$connectHeading.ForeColor = $ColorInk
$connectHeading.Location = New-Object System.Drawing.Point(36, 108)
$connectHeading.Size = New-Object System.Drawing.Size(260, 24)
$form.Controls.Add($connectHeading)

$shareLabel = New-Object System.Windows.Forms.Label
$shareLabel.Text = 'Share path'
$shareLabel.Location = New-Object System.Drawing.Point(36, 150)
$shareLabel.Size = New-Object System.Drawing.Size(110, 22)
$shareLabel.ForeColor = $ColorMuted
$form.Controls.Add($shareLabel)

$shareBox = New-Object System.Windows.Forms.ComboBox
$shareBox.DropDownStyle = 'DropDown'
$SharePresets | ForEach-Object { [void]$shareBox.Items.Add($_) }
$shareBox.Text = $DefaultShare
$shareBox.Location = New-Object System.Drawing.Point(152, 148)
$shareBox.Size = New-Object System.Drawing.Size(672, 26)
$form.Controls.Add($shareBox)

$driveLabel = New-Object System.Windows.Forms.Label
$driveLabel.Text = 'Drive letter'
$driveLabel.Location = New-Object System.Drawing.Point(36, 188)
$driveLabel.Size = New-Object System.Drawing.Size(110, 22)
$driveLabel.ForeColor = $ColorMuted
$form.Controls.Add($driveLabel)

$driveBox = New-Object System.Windows.Forms.ComboBox
$driveBox.DropDownStyle = 'DropDownList'
$driveBox.Location = New-Object System.Drawing.Point(152, 186)
$driveBox.Size = New-Object System.Drawing.Size(200, 26)
$form.Controls.Add($driveBox)
Refresh-DriveList -PreferredDrive $DefaultDrive

$persistBox = New-Object System.Windows.Forms.CheckBox
$persistBox.Text = 'Reconnect at sign-in'
$persistBox.Checked = $true
$persistBox.Location = New-Object System.Drawing.Point(372, 188)
$persistBox.Size = New-Object System.Drawing.Size(170, 22)
$persistBox.ForeColor = $ColorMuted
$persistBox.BackColor = $ColorSurface
$form.Controls.Add($persistBox)

$openBox = New-Object System.Windows.Forms.CheckBox
$openBox.Text = 'Open after connect'
$openBox.Checked = $true
$openBox.Location = New-Object System.Drawing.Point(560, 188)
$openBox.Size = New-Object System.Drawing.Size(160, 22)
$openBox.ForeColor = $ColorMuted
$openBox.BackColor = $ColorSurface
$form.Controls.Add($openBox)

$loginFormatLabel = New-Object System.Windows.Forms.Label
$loginFormatLabel.Text = 'Sign-in format'
$loginFormatLabel.Location = New-Object System.Drawing.Point(36, 226)
$loginFormatLabel.Size = New-Object System.Drawing.Size(110, 22)
$loginFormatLabel.ForeColor = $ColorMuted
$form.Controls.Add($loginFormatLabel)

$loginFormatBox = New-Object System.Windows.Forms.ComboBox
$loginFormatBox.DropDownStyle = 'DropDownList'
$loginFormatBox.Location = New-Object System.Drawing.Point(152, 224)
$loginFormatBox.Size = New-Object System.Drawing.Size(250, 26)
[void]$loginFormatBox.Items.Add('SIRIRAJ\username')
[void]$loginFormatBox.Items.Add('username@siriraj.local')
[void]$loginFormatBox.Items.Add('username only')
if ($loginFormatBox.Items.Contains($DefaultLoginFormat)) {
    $loginFormatBox.SelectedItem = $DefaultLoginFormat
}
else {
    $loginFormatBox.SelectedItem = 'username only'
}
$form.Controls.Add($loginFormatBox)

$loginFormatBox.Add_SelectedIndexChanged({
    if ([string]$loginFormatBox.SelectedItem -eq 'username@siriraj.local') {
        $domainBox.Text = 'siriraj.local'
    }
    elseif ([string]$loginFormatBox.SelectedItem -eq 'SIRIRAJ\username') {
        $domainBox.Text = 'SIRIRAJ'
    }
    elseif ([string]$loginFormatBox.SelectedItem -eq 'username only') {
        $domainBox.Text = ''
    }
})

$domainLabel = New-Object System.Windows.Forms.Label
$domainLabel.Text = 'Domain'
$domainLabel.Location = New-Object System.Drawing.Point(422, 226)
$domainLabel.Size = New-Object System.Drawing.Size(72, 22)
$domainLabel.ForeColor = $ColorMuted
$form.Controls.Add($domainLabel)

$domainBox = New-Object System.Windows.Forms.TextBox
$domainBox.Text = $DefaultDomain
$domainBox.Location = New-Object System.Drawing.Point(500, 224)
$domainBox.Size = New-Object System.Drawing.Size(160, 26)
$form.Controls.Add($domainBox)

$userLabel = New-Object System.Windows.Forms.Label
$userLabel.Text = 'Username'
$userLabel.Location = New-Object System.Drawing.Point(36, 264)
$userLabel.Size = New-Object System.Drawing.Size(110, 22)
$userLabel.ForeColor = $ColorMuted
$form.Controls.Add($userLabel)

$userBox = New-Object System.Windows.Forms.TextBox
$userBox.Text = $DefaultUsername
$userBox.Location = New-Object System.Drawing.Point(152, 262)
$userBox.Size = New-Object System.Drawing.Size(250, 26)
$form.Controls.Add($userBox)

$passwordLabel = New-Object System.Windows.Forms.Label
$passwordLabel.Text = 'Password'
$passwordLabel.Location = New-Object System.Drawing.Point(422, 264)
$passwordLabel.Size = New-Object System.Drawing.Size(72, 22)
$passwordLabel.ForeColor = $ColorMuted
$form.Controls.Add($passwordLabel)

$passwordBox = New-Object System.Windows.Forms.TextBox
$passwordBox.Location = New-Object System.Drawing.Point(500, 262)
$passwordBox.Size = New-Object System.Drawing.Size(160, 26)
$passwordBox.UseSystemPasswordChar = $true
$form.Controls.Add($passwordBox)

$connectButton = New-Object System.Windows.Forms.Button
$connectButton.Text = 'Connect'
$connectButton.Location = New-Object System.Drawing.Point(672, 221)
$connectButton.Size = New-Object System.Drawing.Size(154, 36)
$form.Controls.Add($connectButton)

$forgetButton = New-Object System.Windows.Forms.Button
$forgetButton.Text = 'Forget credentials'
$forgetButton.Location = New-Object System.Drawing.Point(672, 261)
$forgetButton.Size = New-Object System.Drawing.Size(154, 30)
$form.Controls.Add($forgetButton)

# ----- Mounted drives card -----
$drivesPanel = New-Object System.Windows.Forms.Panel
$drivesPanel.Location = New-Object System.Drawing.Point(20, 368)
$drivesPanel.Size = New-Object System.Drawing.Size(840, 214)
$drivesPanel.BackColor = $ColorSurface
$drivesPanel.BorderStyle = 'FixedSingle'
$form.Controls.Add($drivesPanel)

$mappingLabel = New-Object System.Windows.Forms.Label
$mappingLabel.Text = 'Mounted network drives:  click a row to tick, double-click to open'
$mappingLabel.Font = New-Object System.Drawing.Font('Segoe UI', 11, [System.Drawing.FontStyle]::Bold)
$mappingLabel.ForeColor = $ColorInk
$mappingLabel.Location = New-Object System.Drawing.Point(36, 380)
$mappingLabel.Size = New-Object System.Drawing.Size(590, 22)
$form.Controls.Add($mappingLabel)

# Refresh + Disconnect sit side by side on the list header row (top-right).
$refreshButton = New-Object System.Windows.Forms.Button
$refreshButton.Text = 'Refresh'
$refreshButton.Location = New-Object System.Drawing.Point(638, 376)
$refreshButton.Size = New-Object System.Drawing.Size(96, 30)
$form.Controls.Add($refreshButton)

$disconnectButton = New-Object System.Windows.Forms.Button
$disconnectButton.Text = 'Disconnect'
$disconnectButton.Location = New-Object System.Drawing.Point(740, 376)
$disconnectButton.Size = New-Object System.Drawing.Size(104, 30)
$form.Controls.Add($disconnectButton)

# Mounted drives: checkbox multi-select (header toggles all/none), scrollable, click a row to open.
$mappingList = New-Object System.Windows.Forms.ListView
$mappingList.Location = New-Object System.Drawing.Point(36, 412)
$mappingList.Size = New-Object System.Drawing.Size(808, 168)
$mappingList.View = 'Details'
$mappingList.FullRowSelect = $true
$mappingList.GridLines = $false
$mappingList.CheckBoxes = $true
$mappingList.MultiSelect = $true
$mappingList.HideSelection = $false
$mappingList.Scrollable = $true
$mappingList.BackColor = $ColorSurfaceAlt
$mappingList.ForeColor = $ColorInk
$mappingList.Font = New-Object System.Drawing.Font('Consolas', 9)
[void]$mappingList.Columns.Add('Drive', 150)
[void]$mappingList.Columns.Add('Share', 360)
[void]$mappingList.Columns.Add('User', 190)
[void]$mappingList.Columns.Add('Status', 100)
$form.Controls.Add($mappingList)

# ----- Activity card -----
$activityPanel = New-Object System.Windows.Forms.Panel
$activityPanel.Location = New-Object System.Drawing.Point(20, 592)
$activityPanel.Size = New-Object System.Drawing.Size(840, 88)
$activityPanel.BackColor = $ColorSurface
$activityPanel.BorderStyle = 'FixedSingle'
$form.Controls.Add($activityPanel)

$statusLabel = New-Object System.Windows.Forms.Label
$statusLabel.Text = 'Activity'
$statusLabel.Font = New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Bold)
$statusLabel.ForeColor = $ColorInk
$statusLabel.Location = New-Object System.Drawing.Point(36, 602)
$statusLabel.Size = New-Object System.Drawing.Size(160, 20)
$form.Controls.Add($statusLabel)

$statusBox = New-Object System.Windows.Forms.TextBox
$statusBox.Location = New-Object System.Drawing.Point(36, 626)
$statusBox.Size = New-Object System.Drawing.Size(808, 44)
$statusBox.Multiline = $true
$statusBox.ReadOnly = $true
$statusBox.ScrollBars = 'Vertical'
$statusBox.BackColor = $ColorSurfaceAlt
$statusBox.ForeColor = $ColorInk
$statusBox.Font = New-Object System.Drawing.Font('Consolas', 9)
$statusBox.BorderStyle = 'None'
$form.Controls.Add($statusBox)

Set-ButtonStyle -Button $connectButton -BackColor $ColorCyan -ForeColor ([System.Drawing.Color]::White)
$connectButton.Font = New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Bold)
Set-ButtonStyle -Button $disconnectButton -BackColor $ColorDanger -ForeColor ([System.Drawing.Color]::White)
Set-ButtonStyle -Button $forgetButton -BackColor $ColorSurfaceAlt -ForeColor $ColorOcean
Set-ButtonStyle -Button $refreshButton -BackColor $ColorSurfaceAlt -ForeColor $ColorOcean

$connectPanel.SendToBack()
$drivesPanel.SendToBack()
$activityPanel.SendToBack()
$disconnectButton.BringToFront()
$refreshButton.BringToFront()

$trayMenu = New-Object System.Windows.Forms.ContextMenuStrip
$trayStatusItem = New-Object System.Windows.Forms.ToolStripMenuItem -ArgumentList $AppTitle
$trayStatusItem.Enabled = $false
$openTrayItem = New-Object System.Windows.Forms.ToolStripMenuItem -ArgumentList 'Open mapper'
$refreshTrayItem = New-Object System.Windows.Forms.ToolStripMenuItem -ArgumentList 'Refresh status'
$exitTrayItem = New-Object System.Windows.Forms.ToolStripMenuItem -ArgumentList 'Exit'
[void]$trayMenu.Items.Add($trayStatusItem)
[void]$trayMenu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
[void]$trayMenu.Items.Add($openTrayItem)
[void]$trayMenu.Items.Add($refreshTrayItem)
[void]$trayMenu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
[void]$trayMenu.Items.Add($exitTrayItem)

$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$notifyIcon.Icon = New-SispTrayIcon
$notifyIcon.Text = $AppTitle
$notifyIcon.ContextMenuStrip = $trayMenu
$notifyIcon.Visible = $true

$refreshTimer = New-Object System.Windows.Forms.Timer
$refreshTimer.Interval = 10000

$connectButton.Add_Click({
    $share = $shareBox.Text.Trim()
    $drive = Get-SelectedDrive
    $username = $userBox.Text.Trim()
    $password = $passwordBox.Text

    if ($share -notmatch '^\\\\[^\\]+\\[^\\]+') {
        Show-Warning "Enter a valid UNC path, for example \\$GatewayServer\sisplockers."
        return
    }

    if ($username.Length -eq 0) {
        Show-Warning 'Enter your LDAP username.'
        return
    }

    if ($password.Length -eq 0) {
        Show-Warning 'Enter your LDAP password.'
        return
    }

    $qualifiedUser = Get-QualifiedUsername -Username $username -Domain $domainBox.Text -LoginFormat ([string]$loginFormatBox.SelectedItem)
    $shareServer = Get-ShareServer -SharePath $share
    $conflictingMappings = @(Get-ServerMappings -Server $shareServer | Where-Object {
        $_.LocalPath -ne $drive -and
        -not [string]::IsNullOrWhiteSpace($_.UserName) -and
        $_.UserName.ToLowerInvariant() -ne $qualifiedUser.ToLowerInvariant()
    })

    if ($conflictingMappings.Count -gt 0) {
        $otherUsers = ($conflictingMappings | Select-Object -ExpandProperty UserName -Unique) -join ', '
        $otherDrives = ($conflictingMappings | ForEach-Object { "$($_.LocalPath) $($_.RemotePath)" }) -join "`r`n"
        $answer = [System.Windows.Forms.MessageBox]::Show(
            "Windows already has a connection to $shareServer using: $otherUsers.`r`n`r`n$otherDrives`r`n`r`nWindows usually cannot connect to the same server with different credentials at the same time. Continue anyway?",
            $AppTitle,
            'YesNo',
            'Warning'
        )

        if ($answer -ne 'Yes') {
            return
        }
    }

    $existing = Get-DriveInfo -Drive $drive

    if ($null -ne $existing -and $existing.DriveType -ne 4) {
        Show-Warning "$drive is already used by a $((Get-DriveTypeName -DriveType $existing.DriveType)). Choose a free drive letter or an existing network mapping."
        return
    }

    $network = $null
    try {
        $network = New-NetworkObject

        if ($null -ne $existing -and $existing.DriveType -eq 4) {
            $answer = [System.Windows.Forms.MessageBox]::Show(
                "$drive is already mapped to $($existing.ProviderName).`r`n`r`nReplace it with $share using $qualifiedUser?",
                $AppTitle,
                'YesNo',
                'Warning'
            )

            if ($answer -ne 'Yes') {
                return
            }

            $network.RemoveNetworkDrive($drive, $true, $true)
            Start-Sleep -Milliseconds 500
        }

        # Clear any lingering session/credential to the gateway from a previous user before
        # mapping (prevents error 1219 and stale-identity ownership drift). ADR-004.
        Clear-GatewaySession -Server $shareServer
        Write-Status $statusBox "Connecting $drive to $share as $qualifiedUser ..."
        Set-TrayBusy "connecting $drive..."
        $network.MapNetworkDrive($drive, $share, [bool]$persistBox.Checked, $qualifiedUser, $password)
        $accessCheck = Test-MappedDriveAccess -Drive $drive
        if (-not $accessCheck.Success) {
            try {
                $network.RemoveNetworkDrive($drive, $true, $true)
            }
            catch {
            }

            Refresh-DriveList -PreferredDrive $drive
            Update-MappingView -PreferredDrive $drive
            $passwordBox.Clear()
            $message = "Windows accepted the username/password and created the mapping, but the NAS denied access to $share.`r`n`r`nAccess error: $($accessCheck.Message)`r`n`r`nThis usually means the account identity is valid but is not allowed on the NAS share. Try the other login format, or ask an administrator to add that identity/group to the sisplockers permission model."
            Show-Warning $message
            Write-Status $statusBox "Mapping removed because access check failed: $($accessCheck.Message)"
            return
        }

        $passwordBox.Clear()
        Remember-SharePath -SharePath $share
        Set-MappingUserInfo -Drive $drive -RemotePath $share -UserName $qualifiedUser
        Save-CurrentSettings
        Refresh-DriveList -PreferredDrive $drive
        Update-MappingView -PreferredDrive $drive
        Write-Status $statusBox "Connected $drive to $share."
        Show-TrayNotification "Connected $drive to $share." 'Info'

        if ($openBox.Checked) {
            Start-Process explorer.exe ($drive + '\')
        }
    }
    catch {
        $message = $_.Exception.Message
        if ($message -match '1219' -or $message -match 'multiple connections') {
            $server = Get-ShareServer -SharePath $share
            Show-Warning "Windows already has a connection to $server using another credential. Disconnect the old mapping first, then connect again."
        }
        else {
            Show-Warning "Connection failed: $message"
        }
        Write-Status $statusBox "Connection failed: $message"
        Update-MappingView
    }
    finally {
        if ($null -ne $network) {
            [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($network)
        }
    }
})

$disconnectButton.Add_Click({
    $drives = @(Get-CheckedMappingDrives)
    if ($drives.Count -eq 0) {
        $sel = Get-SelectedMappingDrive
        if (-not [string]::IsNullOrWhiteSpace($sel)) { $drives = @($sel) }
    }
    if ($drives.Count -eq 0) {
        Show-Warning 'Tick one or more mounted drives first.'
        return
    }

    $answer = [System.Windows.Forms.MessageBox]::Show(
        "Disconnect $($drives.Count) drive(s)?`r`n`r`n$($drives -join '   ')",
        $AppTitle,
        'YesNo',
        'Question'
    )
    if ($answer -ne 'Yes') {
        return
    }

    $network = $null
    $done = 0
    try {
        $network = New-NetworkObject
        foreach ($drive in $drives) {
            try {
                $existing = Get-DriveInfo -Drive $drive
                if ($null -eq $existing -or $existing.DriveType -ne 4) {
                    Write-Status $statusBox "$drive is not mapped."
                    continue
                }
                Set-TrayBusy "disconnecting $drive..."
                $network.RemoveNetworkDrive($drive, $true, $true)
                Remove-MappingUserInfo -Drive $drive
                Write-Status $statusBox "Disconnected $drive."
                $done++
            }
            catch {
                Write-Status $statusBox "Disconnect $drive failed: $($_.Exception.Message)"
            }
        }
        Save-CurrentSettings
        Refresh-DriveList
        Update-MappingView
        if ($done -gt 0) { Show-TrayNotification "Disconnected $done drive(s)." 'Info' }
    }
    catch {
        Show-Warning "Disconnect failed: $($_.Exception.Message)"
        Update-MappingView
    }
    finally {
        if ($null -ne $network) {
            [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($network)
        }
    }
})

$refreshButton.Add_Click({
    Save-CurrentSettings
    $preferred = Get-SelectedMappingDrive
    if ([string]::IsNullOrWhiteSpace($preferred)) {
        $preferred = Get-SelectedDrive
    }
    Refresh-DriveList -PreferredDrive $preferred
    Update-MappingView -PreferredDrive $preferred
    Write-Status $statusBox 'Refreshed drive and mapping status.'
})

# Single-click anywhere on a row (the drive text, not just the small checkbox) toggles its tick,
# so the whole row is clickable to select. Opening is on double-click (below) to avoid mistakes.
$script:LastToggled = $null
$mappingList.Add_MouseClick({
    param($eventSender, $e)
    $info = $mappingList.HitTest($e.Location)
    $script:LastToggled = $null
    if ($null -eq $info -or $null -eq $info.Item -or $null -eq $info.Item.Tag) { return }
    # The native checkbox (StateImage) toggles itself; toggle here only for clicks on the row text.
    if ($info.Location -ne [System.Windows.Forms.ListViewHitTestLocations]::StateImage) {
        $info.Item.Checked = -not $info.Item.Checked
        $script:LastToggled = $info.Item
    }
})

# Double-click opens that drive in Explorer. A double-click also fired one MouseClick above (which
# toggled the tick), so undo that stray toggle first, opening must never change the selection.
$mappingList.Add_DoubleClick({
    if ($null -ne $script:LastToggled) {
        $script:LastToggled.Checked = -not $script:LastToggled.Checked
        $script:LastToggled = $null
    }
    $m = $null
    if ($mappingList.SelectedItems.Count -gt 0) { $m = $mappingList.SelectedItems[0].Tag }
    if ($null -eq $m) { return }
    $drive = [string]$m.LocalPath
    if ($drive -match '^[A-Z]:$') {
        $path = $drive + '\'
        if (Test-Path $path) { Start-Process explorer.exe $path }
    }
})

# Clicking the first column header toggles all checkboxes (select all / none).
$mappingList.Add_ColumnClick({
    param($eventSender, $e)
    if ($e.Column -ne 0) { return }
    $rows = @($mappingList.Items | Where-Object { $null -ne $_.Tag })
    if ($rows.Count -eq 0) { return }
    $allChecked = -not ($rows | Where-Object { -not $_.Checked })
    foreach ($it in $rows) { $it.Checked = (-not $allChecked) }
    Update-MappingActionButtons
})

$mappingList.Add_ItemChecked({ Update-MappingActionButtons })

$mappingList.Add_SelectedIndexChanged({
    $drive = Get-SelectedMappingDrive
    if (-not [string]::IsNullOrWhiteSpace($drive)) {
        Select-DriveBoxDrive -Drive $drive
    }
})

$forgetButton.Add_Click({
    $share = $shareBox.Text.Trim()
    $server = Get-ShareServer -SharePath $share

    if ($null -eq $server) {
        Show-Warning 'Enter a valid share path first.'
        return
    }

    try {
        $cmdkey = Join-Path $env:SystemRoot 'System32\cmdkey.exe'
        $output = & $cmdkey "/delete:$server" 2>&1
        Save-CurrentSettings
        Write-Status $statusBox "Credential delete attempted for $server. $output"
        Update-MappingView
        Show-Info "Saved Windows credentials for $server were removed if they existed."
    }
    catch {
        Show-Warning "Could not remove saved credentials: $($_.Exception.Message)"
        Write-Status $statusBox "Credential removal failed: $($_.Exception.Message)"
    }
})

$openTrayItem.Add_Click({
    Show-MainWindow
})

$refreshTrayItem.Add_Click({
    Refresh-DriveList -PreferredDrive (Get-SelectedDrive)
    Update-MappingView
})

$exitTrayItem.Add_Click({
    $script:ExitRequested = $true
    $refreshTimer.Stop()
    $notifyIcon.Visible = $false
    $form.Close()
})

$notifyIcon.Add_DoubleClick({
    Show-MainWindow
})

$refreshTimer.Add_Tick({
    Update-MappingView
})

$shareBox.Add_Leave({
    Remember-SharePath -SharePath $shareBox.Text
})

$form.Add_Shown({
    Refresh-DriveList -PreferredDrive $DefaultDrive
    Update-MappingView
    Write-Status $statusBox "Sign in with your plain lab username (the gateway uses your LDAP account). No SIRIRAJ\ prefix needed."
    Write-Status $statusBox 'Close or minimize this window to keep the mapper running in the tray.'
    $userBox.Focus()
})

$form.Add_Resize({
    if ($form.WindowState -eq [System.Windows.Forms.FormWindowState]::Minimized) {
        $form.Hide()
        $notifyIcon.ShowBalloonTip(1500, $AppTitle, 'Still running in the notification area.', 'Info')
    }
})

$form.Add_FormClosing({
    if (-not $script:ExitRequested) {
        Save-CurrentSettings
        $_.Cancel = $true
        $form.Hide()
        $notifyIcon.ShowBalloonTip(1500, $AppTitle, 'Still running in the notification area. Use tray menu Exit to quit.', 'Info')
    }
    else {
        Save-CurrentSettings
        $refreshTimer.Stop()
        $notifyIcon.Visible = $false
        $notifyIcon.Dispose()
    }
})

$refreshTimer.Start()

[void][System.Windows.Forms.Application]::Run($form)
