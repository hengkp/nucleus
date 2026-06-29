#define MyAppName "SISP NAS Drive Mapper"
#define MyAppVersion "1.3.0"
#define MyAppPublisher "SISP"
#define MyAppURL "https://mapdrive.sisp.com"
#define SourceRoot "..\windows"

[Setup]
AppId={{D60E6BB7-5F67-48AA-ACB8-5C0C3E6010A1}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={autopf}\SISPDriveMapper
DefaultGroupName=SISP
DisableProgramGroupPage=yes
; Install for all users into Program Files so it shows in Add/Remove Programs and uninstalls cleanly.
PrivilegesRequired=admin
OutputDir=.
OutputBaseFilename=SISPDriveMapperSetup
SetupIconFile={#SourceRoot}\assets\app-icon.ico
UninstallDisplayName={#MyAppName}
UninstallDisplayIcon={app}\assets\app-icon.ico
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"; Flags: checkedonce
Name: "startup"; Description: "Start automatically when I sign in"; GroupDescription: "Startup:"; Flags: checkedonce

[Files]
Source: "{#SourceRoot}\SISPDriveMapper.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceRoot}\SISPDriveMapper.cmd"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceRoot}\SISPDriveMapperLauncher.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceRoot}\SISPDriveMapperUninstaller.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceRoot}\assets\*"; DestDir: "{app}\assets"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\SISPDriveMapperLauncher.exe"; WorkingDir: "{app}"; IconFilename: "{app}\assets\app-icon.ico"; IconIndex: 0
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{app}\SISPDriveMapperUninstaller.exe"; WorkingDir: "{app}"; IconFilename: "{app}\assets\app-icon.ico"; IconIndex: 0
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\SISPDriveMapperLauncher.exe"; WorkingDir: "{app}"; IconFilename: "{app}\assets\app-icon.ico"; IconIndex: 0; Tasks: desktopicon
Name: "{commonstartup}\{#MyAppName}"; Filename: "{app}\SISPDriveMapperLauncher.exe"; WorkingDir: "{app}"; IconFilename: "{app}\assets\app-icon.ico"; IconIndex: 0; Tasks: startup

[Registry]
Root: HKLM; Subkey: "Software\Classes\sispdrive"; ValueType: string; ValueName: ""; ValueData: "URL:SISP Drive Mapper"; Flags: uninsdeletekey
Root: HKLM; Subkey: "Software\Classes\sispdrive"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""; Flags: uninsdeletevalue
Root: HKLM; Subkey: "Software\Classes\sispdrive\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: "{app}\assets\app-icon.ico,0"; Flags: uninsdeletekey
Root: HKLM; Subkey: "Software\Classes\sispdrive\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\SISPDriveMapperLauncher.exe"" ""%1"""; Flags: uninsdeletekey

[Run]
Filename: "{app}\SISPDriveMapperLauncher.exe"; Description: "Open SISP NAS Drive Mapper"; Flags: nowait postinstall skipifsilent
