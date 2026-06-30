# MapDrive tray icon set, image-generation prompts

## Instructions for Codex (read this first)

Generate three tray icons by calling the **GPT image 2.0** image-generation tool
directly, once per prompt below. Do **not** write Python, PIL, or any other code
to draw the icons, and do not download anything. Just pass each prompt straight
to the GPT image 2.0 tool and save what it returns.

- Run the tool three times, one per prompt in the sections below.
- Each output: a single square PNG, transparent background, 1024 x 1024.
- Save them, in this folder, as:
  - Prompt 1 to `connected-source.png`
  - Prompt 2 to `connecting-source.png`
  - Prompt 3 to `disconnected-source.png`
- The three sources must be transparent PNGs (no background). If the image tool
  only returns an opaque/keyed image, key out the flat background to alpha before
  saving here. From these three transparent sources the maintainer regenerates the
  sized PNGs (16 to 256 px), the Windows `.ico` files, and the macOS 18 / 36 px
  menu-bar PNGs; just leave the three updated source PNGs in this folder.

Why this redesign: the old set drew the same black network drive for all three
states with only a small corner mark, so at 16 px in the system tray you could
not tell connect, connecting, and disconnect apart. These three share one drive
shape but make the state loud, with a large color-coded badge plus a body tint,
so the state reads instantly even when tiny. Each prompt below is complete on its
own, so they can be generated independently and still look like one family.

---

## Prompt 1 of 3, CONNECTED, save as `connected-source.png`

```
A single modern flat vector app icon, 1024 x 1024 pixels, on a FULLY TRANSPARENT background (real alpha, no white fill, no checkerboard, no border, no text, no watermark). Center the artwork with about 8 percent padding on all sides.

Subject: a friendly modern network storage drive (a NAS), drawn as a rounded-rectangle drive body seen straight from the front, with one slim horizontal seam line across it and one small round status LED near its lower-left. Above the drive sit three short, clean concentric connectivity arcs (a signal fan) rising from the top-center. Use a single consistent corner radius, a bold even stroke weight that stays crisp when scaled down to 16 px, smooth rounded line caps, and gentle subtle top-down shading for a little depth. No drop shadow. Premium, fluent, not clip-art.

State = CONNECTED: the drive body is a confident deep teal (about #0E7C7B) with a soft lighter teal highlight along the top, and all three signal arcs are bright and complete in teal. Add one LARGE circular status badge overlapping the lower-right corner of the drive: a solid filled circle about 46 percent of the icon width, emerald green (about #22C55E), separated from the drive by a clean 3 px transparent gap plus a thin white inner ring, with a crisp bold pure-white check mark centered inside it. The badge, badge symbol, signal arcs, and LED are the only colored parts. Flat vector illustration, high contrast, transparent background, no text.
```

---

## Prompt 2 of 3, CONNECTING, save as `connecting-source.png`

```
A single modern flat vector app icon, 1024 x 1024 pixels, on a FULLY TRANSPARENT background (real alpha, no white fill, no checkerboard, no border, no text, no watermark). Center the artwork with about 8 percent padding on all sides.

Subject: a friendly modern network storage drive (a NAS), drawn as a rounded-rectangle drive body seen straight from the front, with one slim horizontal seam line across it and one small round status LED near its lower-left. Above the drive sit three short, clean concentric connectivity arcs (a signal fan) rising from the top-center. Use a single consistent corner radius, a bold even stroke weight that stays crisp when scaled down to 16 px, smooth rounded line caps, and gentle subtle top-down shading for a little depth. No drop shadow. Premium, fluent, not clip-art. Keep the drive shape, stroke weight, arc geometry, and badge size identical to the connected and disconnected icons in this family.

State = CONNECTING: the drive body is the same confident deep teal (about #0E7C7B) with a soft lighter teal top highlight; the signal arcs look mid-transmission, with the outermost arc faded to about half opacity to suggest motion. Add one LARGE circular status badge overlapping the lower-right corner of the drive: a solid filled circle about 46 percent of the icon width, warm amber (about #F59E0B), separated from the drive by a clean 3 px transparent gap plus a thin white inner ring, with two crisp pure-white curved arrows chasing each other in a circle (a sync / refresh loop) centered inside it. The badge, badge symbol, signal arcs, and LED are the only colored parts. Flat vector illustration, high contrast, transparent background, no text.
```

---

## Prompt 3 of 3, DISCONNECTED, save as `disconnected-source.png`

```
A single modern flat vector app icon, 1024 x 1024 pixels, on a FULLY TRANSPARENT background (real alpha, no white fill, no checkerboard, no border, no text, no watermark). Center the artwork with about 8 percent padding on all sides.

Subject: a friendly modern network storage drive (a NAS), drawn as a rounded-rectangle drive body seen straight from the front, with one slim horizontal seam line across it and one small round status LED near its lower-left. Above the drive sit short concentric connectivity arcs (a signal fan) rising from the top-center. Use a single consistent corner radius, a bold even stroke weight that stays crisp when scaled down to 16 px, smooth rounded line caps. No drop shadow. Premium, fluent, not clip-art. Keep the drive shape, stroke weight, arc geometry, and badge size identical to the connected and connecting icons in this family.

State = DISCONNECTED: the drive body is a desaturated cool slate grey (about #94A3B8) with NO top highlight so it clearly reads as inactive and dimmed; the signal arcs are dimmed grey and the topmost (outer) arc is omitted. Add one LARGE circular status badge overlapping the lower-right corner of the drive: a solid filled circle about 46 percent of the icon width, red (about #EF4444), separated from the drive by a clean 3 px transparent gap plus a thin white inner ring, with a crisp bold pure-white X (cross) centered inside it. The badge and its X are the only saturated color; the rest stays muted grey. Flat vector illustration, high contrast, transparent background, no text.
```

---

## If the result has a background

If any image comes back with a solid or checkerboard background instead of real
transparency, regenerate that one and add "must have genuine alpha transparency,
absolutely no background fill" to the prompt. Colors map to the SISP palette:
teal heritage for the drive, semantic green / amber / red for the live state.
