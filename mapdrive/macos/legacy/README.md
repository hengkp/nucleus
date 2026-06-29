# macOS Helper

This is a lightweight macOS helper for opening SISP NAS shares through Finder SMB.

Run:

```zsh
chmod +x SISPDriveMapper.command
./SISPDriveMapper.command
```

The helper opens URLs such as:

```text
smb://username@192.168.0.103/sisplockers
```

macOS will ask for the LDAP password and can save it in Keychain.

The included `SISP Drive Mapper.app` folder is an unsigned app-bundle wrapper around the command script. A polished signed `.app` or `.pkg` installer needs to be built and signed on macOS with an Apple Developer certificate.
