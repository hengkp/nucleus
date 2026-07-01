# SISP MapDrive for macOS

A small menu-bar app that connects the lab's SMB shares with one click, the macOS
counterpart of the Windows tray app. The menu-bar icon shows whether anything is
connected, and each share has a checkmark when it is mounted.

## What it does

- Lives in the menu bar (no Dock icon).
- Two connection modes, matching the web app:
  - **Gateway (recommended)** - `192.168.0.25`, sign in with your plain lab username.
  - **Direct NAS** - `192.168.0.103`, sign in as `SIRIRAJ\username`.
- Set your username once (stored locally). The first time you mount a share, macOS
  shows its normal sign-in dialog and offers to save the password to your Keychain,
  so later connections are silent.
- Mounts appear under `/Volumes/<share>` and in Finder, exactly like any network drive.

## Build

You need the Xcode Command Line Tools (`xcode-select --install`). No Xcode project required.

```sh
cd mapdrive/macos
./build.sh          # produces MapDrive.app
open MapDrive.app   # a drive icon appears in the menu bar
```

Quick test without bundling:

```sh
swiftc MapDrive.swift -o MapDrive -framework Cocoa && ./MapDrive
```

## First run / Gatekeeper

The app is unsigned, so the first launch needs: right-click `MapDrive.app` ->
**Open** -> **Open**. (Or `xattr -dr com.apple.quarantine MapDrive.app`.)
For wider distribution, sign and notarize it with your Apple Developer ID.

## Start at login

System Settings -> General -> Login Items -> add `MapDrive.app`.

## Menu-bar icons

`assets/` ships the shared MapDrive status art (white NAS stack + status badge) as the
menu-bar icons: `connected.png` / `connected@2x.png` (green check) and
`disconnected.png` / `disconnected@2x.png` (white-ringed X), 18 pt @1x/@2x. These are the
white variants of the Windows tray set, so both platforms share one look. They are loaded
as full-colour (non-template) images — tuned for a dark menu bar; on a light menu bar the
white stack recedes and the coloured badge carries the status. `build.sh` copies them to
`MapDrive.app/Contents/Resources/`.

If either PNG is missing, the app falls back to the SF Symbols
`externaldrive.fill.badge.checkmark` (connected) and `externaldrive.badge.xmark`
(disconnected), rendered as template images that adapt to a light or dark menu bar.

## Editing the share list

The shares live in the `MODES` array near the top of `MapDrive.swift`; it mirrors
`mapdrive.sisp.com/config/share-presets.json`. Update it there and rebuild, or extend the
app to fetch that JSON at launch so it stays in sync automatically.

## Notes

- Mounting uses the system `mount volume` call, so all authentication and Keychain
  handling is the standard macOS flow - no passwords are stored by this app.
- Unmounting uses `diskutil unmount`.
- For the shares to resolve, your Mac must be on the lab network (or VPN) so
  `192.168.0.25` / `192.168.0.103` are reachable.
