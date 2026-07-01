# MapDrive tray icons

System-tray status icons for the Windows app. The mark is the MapDrive brand glyph — a
hexagon network-node linked to an external drive — the same family as the app icon and
logo, redrawn bold and flat so it stays legible at 16 px.

| State | File loaded by `SISPDriveMapper.ps1` | Look |
| --- | --- | --- |
| Connected | `connected.ico` | teal drive + green node, solid link (colour; reads on any taskbar) |
| Disconnected, light taskbar | `disconnected.ico` | slate mono, hollow node, broken link |
| Disconnected, dark taskbar | `disconnected-darktheme.ico` | white mono, hollow node, broken link |

`Get-TrayIconAssetPath` picks the light vs. dark disconnected variant from
`SystemUsesLightTheme`. Each `.ico` embeds 16/20/24/32/48/64/256-px frames.

## Regenerate

The icons are drawn deterministically (no AI, no manual pixel editing) so they stay crisp
and reproducible. Only dependency is Pillow.

```sh
pip install pillow
python generate-tray-icons.py            # rebuild .ico + .png set
python generate-tray-icons.py --preview  # also write _preview.png (light/dark contact sheet)
```

Edit the geometry or palette constants at the top of `generate-tray-icons.py` to adjust the
mark. Palette: teal `#11695f`, connected green `#2e9b5f`, slate `#131a19`, paper `#f7f9f9`.

`CODEX_PROMPT.md` describes the earlier AI-generated approach and is kept for history only.
