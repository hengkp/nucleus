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

Design goal: a much simpler, bolder mark that stays crystal clear at 16 px in
the system tray. One single storage drive seen from the TOP, with a very thick
black outline and a cloud in its centre. The state is shown by the fill colour:
ocean green when connected, yuzu yellow while connecting, and no fill plus a
single diagonal black slash through the whole drive when disconnected (the way
the OneDrive tray icon looks when you are not signed in). The thick outline and
the solid fill colour are what make the three states readable at tiny sizes.

Keep the drive shape, the outline thickness, the cloud, its size and position,
and the framing pixel-for-pixel identical across all three icons. Only the fill
colour changes, plus the added slash on the disconnected one.

---

## Prompt 1 of 3, CONNECTED, save as `connected-source.png`

```
A single flat vector app icon, 1024 x 1024 pixels, on a FULLY TRANSPARENT background (real alpha, no background fill, no checkerboard, no border, no text, no shadow, no watermark). Center the artwork with about 12 percent padding on every side.

Draw exactly ONE object: a computer storage drive (an external hard drive / NAS unit) seen straight from the TOP, as a bird's-eye view. It is a single bold rounded rectangle, clearly wider than it is tall, representing the flat top face of the drive. Outline it with a VERY THICK, heavy, even, solid BLACK stroke with smoothly rounded corners and joins; the outline must be thick enough to read clearly when the whole icon is shrunk to 16 by 16 pixels. In the exact center of the drive sits one simple clean cloud symbol, drawn with the SAME thick black outline and a white fill. There are no other elements at all: no second drive, no signal waves or arcs, no status badge, no dot, no text, no gradient.

State = CONNECTED: fill the inside of the drive (the area inside the thick black outline, behind and around the white cloud) with a solid ocean green, the deep teal-green #11695f (the SISP / AppHub brand green). The cloud stays white on top of the green fill so it reads clearly. Flat solid colors only, crisp thick black linework, transparent background, no text.
```

---

## Prompt 2 of 3, CONNECTING, save as `connecting-source.png`

```
A single flat vector app icon, 1024 x 1024 pixels, on a FULLY TRANSPARENT background (real alpha, no background fill, no checkerboard, no border, no text, no shadow, no watermark). Center the artwork with about 12 percent padding on every side.

Draw exactly ONE object: a computer storage drive (an external hard drive / NAS unit) seen straight from the TOP, as a bird's-eye view. It is a single bold rounded rectangle, clearly wider than it is tall, representing the flat top face of the drive. Outline it with a VERY THICK, heavy, even, solid BLACK stroke with smoothly rounded corners and joins; the outline must be thick enough to read clearly when the whole icon is shrunk to 16 by 16 pixels. In the exact center of the drive sits one simple clean cloud symbol, drawn with the SAME thick black outline and a white fill. There are no other elements at all: no second drive, no signal waves or arcs, no status badge, no dot, no text, no gradient. Keep the drive shape, outline thickness, and the cloud identical to the connected and disconnected icons in this family.

State = CONNECTING: fill the inside of the drive (the area inside the thick black outline, behind and around the white cloud) with a solid vibrant yuzu yellow, a bright saturated warm citrus yellow #F5C518. The cloud stays white on top of the yellow fill so it reads clearly. Flat solid colors only, crisp thick black linework, transparent background, no text.
```

---

## Prompt 3 of 3, DISCONNECTED, save as `disconnected-source.png`

```
A single flat vector app icon, 1024 x 1024 pixels, on a FULLY TRANSPARENT background (real alpha, no background fill, no checkerboard, no border, no text, no shadow, no watermark). Center the artwork with about 12 percent padding on every side.

Draw exactly ONE object: a computer storage drive (an external hard drive / NAS unit) seen straight from the TOP, as a bird's-eye view. It is a single bold rounded rectangle, clearly wider than it is tall, representing the flat top face of the drive. Outline it with a VERY THICK, heavy, even, solid BLACK stroke with smoothly rounded corners and joins; the outline must be thick enough to read clearly when the whole icon is shrunk to 16 by 16 pixels. In the exact center of the drive sits one simple clean cloud symbol, drawn with the SAME thick black outline. There are no other elements at all: no second drive, no signal waves or arcs, no status badge, no dot, no text, no gradient. Keep the drive shape, outline thickness, and the cloud identical to the connected and connecting icons in this family.

State = DISCONNECTED: NO fill color at all. The inside of the drive stays fully transparent, so only the thick black drive outline and the black cloud outline are visible (the cloud has a transparent inside too). Then draw ONE bold straight BLACK diagonal slash running from the upper-left down to the lower-right, straight across the entire drive logo, in the same heavy black weight as the drive outline, exactly like the Microsoft OneDrive tray icon when you are signed out / not connected. Flat black linework only, no color, transparent background, no text.
```

---

## If the result has a background

If any image comes back with a solid or checkerboard background instead of real
transparency, regenerate that one and add "must have genuine alpha transparency,
absolutely no background fill" to the prompt. Colour reference: connected fill =
ocean green #11695f (AppHub brand green, deeper shade #0c4f47); connecting fill =
vibrant yuzu yellow #F5C518; disconnected = no fill, black diagonal slash.
