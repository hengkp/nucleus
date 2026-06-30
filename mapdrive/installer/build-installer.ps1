$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$WindowsApp = Join-Path $ProjectRoot 'windows'
$MacApp = Join-Path $ProjectRoot 'macos'
$WebDownloads = Join-Path $ProjectRoot 'web\downloads'
$OutputExe = Join-Path $PSScriptRoot 'SISPDriveMapperSetup.exe'
$LauncherSource = Join-Path $WindowsApp 'src\SISPDriveMapperLauncher.cs'
$UninstallerSource = Join-Path $WindowsApp 'src\SISPDriveMapperUninstaller.cs'
$LauncherExe = Join-Path $WindowsApp 'SISPDriveMapperLauncher.exe'
$UninstallerExe = Join-Path $WindowsApp 'SISPDriveMapperUninstaller.exe'
$Icon = Join-Path $WindowsApp 'assets\app-icon.ico'
$Csc = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$IsccCandidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe'),
    'C:\Program Files (x86)\Inno Setup 6\ISCC.exe',
    'C:\Program Files\Inno Setup 6\ISCC.exe'
)
$Iscc = $IsccCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

if (-not (Test-Path -LiteralPath $Csc)) {
    throw "C# compiler not found: $Csc"
}
if (-not $Iscc) {
    throw 'Inno Setup compiler ISCC.exe was not found.'
}

Remove-Item -LiteralPath $OutputExe -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $LauncherExe, $UninstallerExe -Force -ErrorAction SilentlyContinue

& $Csc /nologo /target:winexe /platform:anycpu /win32icon:$Icon /out:$LauncherExe /reference:System.Windows.Forms.dll $LauncherSource
& $Csc /nologo /target:winexe /platform:anycpu /win32icon:$Icon /out:$UninstallerExe /reference:System.Windows.Forms.dll /reference:System.Management.dll $UninstallerSource

& $Iscc (Join-Path $PSScriptRoot 'SISPDriveMapper.iss')

if (-not (Test-Path -LiteralPath $OutputExe)) {
    throw "Installer was not created: $OutputExe"
}

New-Item -ItemType Directory -Force -Path $WebDownloads | Out-Null
Copy-Item -LiteralPath $OutputExe -Destination (Join-Path $WebDownloads 'SISPDriveMapperSetup.exe') -Force

# Portable ZIP removed: it did not work as a standalone (no installed shortcuts / file
# associations), so we ship only the installer.
$macZipForWeb = Join-Path $WebDownloads 'SISPDriveMapper-macOS.zip'
if (Test-Path -LiteralPath $MacApp) {
    Remove-Item -LiteralPath $macZipForWeb -Force -ErrorAction SilentlyContinue
    Compress-Archive -Path (Join-Path $MacApp '*') -DestinationPath $macZipForWeb -Force
}

$outputs = @($OutputExe, (Join-Path $WebDownloads 'SISPDriveMapperSetup.exe'))
if (Test-Path -LiteralPath $macZipForWeb) {
    $outputs += $macZipForWeb
}

Get-Item $outputs
