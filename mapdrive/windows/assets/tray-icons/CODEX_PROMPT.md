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
- The three sources must be transparent PNGs (no background). If the tool only
  returns an opaque/keyed image, key out the flat background to alpha before
  saving here. From these three transparent sources the maintainer regenerates
  the sized PNGs (16 to 256 px), the Windows `.ico` files, and the macOS 18 / 36
  px menu-bar PNGs; just leave the three updated source PNGs in this folder.

Design goal: one good-looking 3D storage drive with a cloud on its front,
readable at 16 px in the system tray. The state is shown by the colour that
fills the drive body: a bright ocean green when connected, a vibrant yuzu
yellow while connecting, and no fill plus a single diagonal black slash through
the whole drive when disconnected (the way the OneDrive tray icon looks when you
are not signed in). Use a clean, thick black outline (bold and clear, but not
heavy or chunky).

Keep the drive shape, the 3D angle, the outline weight, the cloud, its size and
position, and the framing pixel-for-pixel identical across all three icons. Only
the fill colour changes, plus the added slash on the disconnected one.

---

## Prompt 1 of 3, CONNECTED, save as `connected-source.png`

```
A single modern flat-3D vector app icon, 1024 x 1024 pixels, on a FULLY TRANSPARENT background (real alpha, no background fill, no checkerboard, no border, no text, no drop shadow, no watermark). Center the artwork with about 12 percent padding on every side.

Draw exactly ONE object: a modern external storage drive (a small NAS unit) shown in a clean three-quarter 3D view, a low wide rounded box where you can see the front face and a thin strip of the top, with softly rounded edges. Give the whole drive a clean, thick, even solid BLACK outline, bold and clearly readable when the icon is shrunk to 16 by 16 pixels, but not heavy or chunky. Centered on the front face of the drive sits one simple clean cloud symbol with the same black outline and a white fill. That is all: no second drive, no signal waves or arcs, no separate floating cloud, no status badge, no dot, no text.

State = CONNECTED: fill the drive body (both the front face and the top strip, around the cloud) with a bright ocean green, the SISP / AppHub brand teal-green #11695f, kept bright and saturated rather than dark. The white cloud sits on top of the green fill so it reads clearly. Flat solid colors only, clean thick black linework, transparent background, no text.
```

---

## Prompt 2 of 3, CONNECTING, save as `connecting-source.png`

```
A single modern flat-3D vector app icon, 1024 x 1024 pixels, on a FULLY TRANSPARENT background (real alpha, no background fill, no checkerboard, no border, no text, no drop shadow, no watermark). Center the artwork with about 12 percent padding on every side.

Draw exactly ONE object: a modern external storage drive (a small NAS unit) shown in a clean three-quarter 3D view, a low wide rounded box where you can see the front face and a thin strip of the top, with softly rounded edges. Give the whole drive a clean, thick, even solid BLACK outline, bold and clearly readable when the icon is shrunk to 16 by 16 pixels, but not heavy or chunky. Centered on the front face of the drive sits one simple clean cloud symbol with the same black outline and a white fill. That is all: no second drive, no signal waves or arcs, no separate floating cloud, no status badge, no dot, no text. Keep the drive shape, the 3D angle, the outline weight, and the cloud identical to the connected and disconnected icons in this family.

State = CONNECTING: fill the drive body (both the front face and the top strip, around the cloud) with a vibrant yuzu yellow, a bright saturated warm citrus yellow #F5C518. The white cloud sits on top of the yellow fill so it reads clearly. Flat solid colors only, clean thick black linework, transparent background, no text.
```

---

## Prompt 3 of 3, DISCONNECTED, save as `disconnected-source.png`

```
A single modern flat-3D vector app icon, 1024 x 1024 pixels, on a FULLY TRANSPARENT background (real alpha, no background fill, no checkerboard, no border, no text, no drop shadow, no watermark). Center the artwork with about 12 percent padding on every side.

Draw exactly ONE object: a modern external storage drive (a small NAS unit) shown in a clean three-quarter 3D view, a low wide rounded box where you can see the front face and a thin strip of the top, with softly rounded edges. Give the whole drive a clean, thick, even solid BLACK outline, bold and clearly readable when the icon is shrunk to 16 by 16 pixels, but not heavy or chunky. Centered on the front face of the drive sits one simple clean cloud symbol with the same black outline. That is all: no second drive, no signal waves or arcs, no separate floating cloud, no status badge, no dot, no text. Keep the drive shape, the 3D angle, the outline weight, and the cloud identical to the connected and connecting icons in this family.

State = DISCONNECTED: NO fill color at all. The drive body and the cloud stay empty (their insides are fully transparent), so only the thick black drive outline and the black cloud outline are visible. Then draw ONE bold straight BLACK diagonal slash running from the upper-left down to the lower-right, straight across the entire drive, in the same black weight as the drive outline, exactly like the Microsoft OneDrive tray icon when you are signed out / not connected. Flat black linework only, no color, transparent background, no text.
```

---

## If the result has a background

If any image comes back with a solid or checkerboard background instead of real
transparency, regenerate that one and add "must have genuine alpha transparency,
absolutely no background fill" to the prompt. Colour reference: connected fill =
bright ocean green #11695f (the AppHub brand green, same as the current
connected icon); connecting fill = vibrant yuzu yellow #F5C518; disconnected =
no fill, single black diagonal slash.
