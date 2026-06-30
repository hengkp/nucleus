# MapDrive tray icon set, Codex / GPT image prompt

One single prompt that produces the full three-state tray icon family in one
consistent image. Paste everything in the fenced block below into Codex (GPT
image) as a single prompt. It returns one transparent 1536 x 512 sheet holding
three 512 x 512 icons in a row: connected, connecting, disconnected. Slice the
sheet into three squares and run them through the existing
`build-tray-icons.ps1` resizer to make the 16 to 256 px PNGs and the .ico files.

Design intent: the old set used the same black drawing for all three states
with only a tiny corner mark, so at 16 px in the tray they were hard to tell
apart. This set keeps one shared network-drive shape but drives the meaning
with a large, color-coded status badge and a state tint, so a quick glance is
enough to read connect vs connecting vs disconnect even at 16 px.

---

```
Create one flat, modern vector-style icon SHEET as a single PNG, 1536 x 512 pixels, on a FULLY TRANSPARENT background (real alpha, no white, no checkerboard). The sheet holds THREE separate app tray icons in one horizontal row. Each icon is perfectly centered inside its own invisible 512 x 512 square cell: cell 1 spans x 0 to 512, cell 2 spans x 512 to 1024, cell 3 spans x 1024 to 1536. Leave about 8 percent padding around each icon so nothing touches the cell edges. Do not draw the cells, gridlines, labels, frames, or any text anywhere.

All three icons share ONE identical base symbol so they read as a family: a friendly, modern network storage drive (a NAS), drawn as a rounded-rectangle drive body seen straight from the front, with one slim horizontal seam line across it and one small round status LED near the lower-left of the body. Above the drive sit three short, clean concentric connectivity arcs (a signal / Wi-Fi fan) rising from the top-center. Use a single consistent corner radius, a consistent bold stroke weight that stays crisp when scaled down to 16 px, smooth rounded line caps, and gentle subtle top-down shading for a little depth. No drop shadow on the transparent background. No outlines around the whole icon. Clean, premium, Apple-and-Microsoft-fluent feeling, not clip-art.

Each icon adds a single LARGE circular STATUS BADGE that overlaps the lower-right corner of the drive body. The badge is bold and unmistakable at tiny sizes: it is a filled solid-color circle about 46 percent of the icon's width, separated from the drive by a clean 3 px transparent gap plus a thin white inner ring, with a crisp pure-white symbol centered inside it. The badge, the badge symbol, the signal arcs, and the LED are the only colored parts; keep the rest readable.

The three states, left to right:

1) CONNECTED (cell 1): the drive body is a confident deep teal (about #0E7C7B) with a soft lighter teal top highlight; the three signal arcs are bright and complete in teal. The status badge is emerald green (about #22C55E) with a bold white check mark.

2) CONNECTING (cell 2): the drive body is the same deep teal; the signal arcs look mid-transmission, the outermost arc faded to roughly half opacity to suggest motion. The status badge is warm amber (about #F59E0B) with two white curved arrows chasing each other in a circle (a sync / refresh loop) centered in the badge.

3) DISCONNECTED (cell 3): the drive body is desaturated cool slate grey (about #94A3B8) so it clearly reads as inactive, with no top highlight; the signal arcs are dimmed grey and the topmost arc is omitted. The status badge is red (about #EF4444) with a bold white X.

Keep the drive shape, stroke weight, arc geometry, badge size, badge ring, and symbol weight pixel-for-pixel identical across all three icons; only the colors, the highlight, the arc opacity, and the badge symbol change between states. Flat vector illustration, high contrast, no gradients other than the subtle body shading described, no background, no text, no extra decoration.
```

---

## Notes for whoever runs this

- If the model will not honor the three-in-one sheet cleanly, run the same prompt three times and each time keep only ONE of the numbered state paragraphs (and ask for a single 512 x 512 transparent icon). The shared-base wording keeps them consistent across runs.
- Output must be transparent PNG. If it comes back with a solid background, re-ask for "real alpha transparency, no background fill."
- After generating, drop the three squares in as `connected-source.png`, `connecting-source.png`, `disconnected-source.png` here, then regenerate the sized PNGs and `.ico` files with the existing build script.
- Colors map to the SISP palette: teal heritage for the drive, semantic green / amber / red for the live state.
