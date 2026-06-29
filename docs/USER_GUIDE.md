# User Guide

1. Open `https://mapdrive.sisp.com`.
2. Download and run `SISPDriveMapperSetup.exe`.
3. Keep `Start automatically when I sign in` enabled.
4. On the Configure tab, choose shared folder, drive letter, login format, and username.
5. Click Open configured app.
6. Enter LDAP password in the Windows helper.
7. Click Connect.

Use `SIRIRAJ\username` first. Try `username@siriraj.local` only if that is the form accepted by Windows/NAS for the account.

Windows usually allows only one SMB credential per server name in one sign-in session. If a user wants to switch accounts for `192.168.0.103`, disconnect existing mapped drives first and use Forget Credentials.

Use the Support tab to post connection problems, reply to other users, react to useful answers, and mark a post solved.

To uninstall, open Start Menu > SISP > Uninstall SISP NAS Drive Mapper. You can also run `SISPDriveMapperUninstaller.exe` from the install folder or remove the app from Windows Settings > Installed Apps.
