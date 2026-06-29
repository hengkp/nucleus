# Security Notes

The web portal does not collect usernames or passwords.

LDAP credentials are entered only into the local Windows tray helper and passed to Windows SMB mapping APIs. The helper does not persist the password in its own settings file. Windows may cache credentials if the user chooses persistent mapping; users can remove cached server credentials with the app's Forget Credentials button.

The installer is built with Inno Setup and registers `sispdrive://open` under `HKCU` so the portal can reopen the installed helper without administrator rights. The older IExpress/PowerShell installer was removed because Windows Defender can flag that packaging pattern.

The share preset list intentionally includes shared/project folders only. Individual user home folders are excluded.

The support board is intended for internal troubleshooting. It does not require login in this first version, so users must not post passwords or private data.
