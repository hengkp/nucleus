# MapDrive tray icons

System-tray status icons for the Windows app. The mark is a bold three-tier NAS stack with
a status badge: a green check when connected, an X when disconnected. Connected also lights
its drive LEDs green.

`SISPDriveMapper.ps1` (`Get-TrayIconAssetPath`) loads:

| State | File | Look |
| --- | --- | --- |
| Connected | `connected.ico` | black stack, green check + green LEDs |
| Disconnected, light taskbar | `disconnected.ico` | black stack, dark X badge |
| Disconnected, dark taskbar | `disconnected-darktheme.ico` | white stack, white-ringed X badge |

The connected badge is green, so it reads on either taskbar from a single file. The
disconnected badge is monochrome, so it ships a light-taskbar (black) and a dark-taskbar
(white) variant, chosen from `SystemUsesLightTheme`. Each `.ico` embeds 16–256 px frames.

The macOS menu-bar app reuses the **white** variants of this same art
(`connected` / `disconnected`) so both platforms share one look — see
`../../../macos/assets/` and `mapdrive/macos/README.md`.

## Source

`source/` holds the 512 px masters and the light/dark status-preview sheets the shipped
icons were exported from (design generated in the `mapdrive-icons-codex` set).
