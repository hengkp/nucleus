# MapDrive tray icon set, image-generation prompts

## Instructions for Codex (read this first)

Generate three tray icons by calling the **GPT image 2.0** image-generation tool
directly, once per prompt below. Do **not** write Python, PIL, or any other code
to draw the icons, and do not download anything. Pass each prompt straight to the
GPT image 2.0 tool and save what it returns.

- Run the tool three times, one per prompt in the sections below.
- Each output: a single square PNG, transparent background, 1024 x 1024.
- Save them, in this folder, as:
  - Prompt 1 to `connected-source.png`
  - Prompt 2 to `connecting-source.png`
  - Prompt 3 to `disconnected-source.png`
- The three sources must be transparent PNGs. If the tool only returns an
  opaque/keyed image, key out the flat background to alpha before saving here.
  From these three transparent sources the maintainer regenerates the sized PNGs
  (16 to 256 px), the Windows `.ico` files, and the macOS 18 / 36 px menu-bar
  PNGs; just leave the three updated source PNGs in this folder.

Design goal: a premium, professional cloud-NAS icon, the quality of a top-tier
macOS / Dribbble app icon, NOT a plain box. It is a detailed modern desktop NAS
storage device shown in a polished three-quarter 3D view with real depth, a
small cloud emblem on the front, and a chunky bold black outline. The state is
read from the colour of the device body and its status light: bright ocean green
when connected, vibrant yuzu yellow while connecting, and greyed-out with a
single diagonal black slash through the whole device when disconnected (like the
OneDrive tray icon when signed out).

Keep the device shape, the 3D angle, the level of detail, the outline weight, the
cloud, and the framing pixel-for-pixel identical across all three icons. Only the
body colour and the status light change, plus the added slash on the
disconnected one.

---

## Prompt 1 of 3, CONNECTED, save as `connected-source.png`

```
A single premium, professional app icon in a polished flat-3D illustration style (the quality of a top-tier macOS or Dribbble cloud-app icon), 1024 x 1024 pixels, on a FULLY TRANSPARENT background (real alpha, no background fill, no checkerboard, no border, no text, no watermark). Center the device with about 10 percent padding.

Subject: one detailed modern desktop NAS network storage device, shown in a three-quarter 3D view with gentle perspective and real depth (you clearly see the front face plus the top and one side). It is an upright rounded-corner chassis sitting on a slim recessed base. Rich but tidy detail: the front face has a clean cloud emblem centered on it, two subtle horizontal drive-bay seam lines, and a slim vertical row of three small round status-LED dots near the right edge; the side face has a column of fine thin ventilation slots; soft rounded edges throughout. Render it with soft studio lighting: a gentle highlight along the top edge, a slightly darker tone on the top and side faces for dimension, and smooth subtle shading inside the faces (not flat, but no harsh gradients). Wrap the whole device, the cloud, the LEDs, and the vents in a bold, CHUNKY, even solid BLACK outline with smoothly rounded corners, plus crisp clean black interior lines for the seams and vents; the linework must stay clearly readable when the icon is shrunk to 16 by 16 pixels. No separate floating cloud, no signal waves, no badge, no text.

State = CONNECTED: the NAS body is a bright, saturated ocean green, the SISP / AppHub brand teal-green #11695f on the lit front face with a slightly deeper green on the shaded top and side faces for depth; the three status LEDs glow bright green; the cloud emblem is white. Flat solid colours with only subtle shading, chunky black linework, transparent background, no text.
```

---

## Prompt 2 of 3, CONNECTING, save as `connecting-source.png`

```
A single premium, professional app icon in a polished flat-3D illustration style (the quality of a top-tier macOS or Dribbble cloud-app icon), 1024 x 1024 pixels, on a FULLY TRANSPARENT background (real alpha, no background fill, no checkerboard, no border, no text, no watermark). Center the device with about 10 percent padding.

Subject: one detailed modern desktop NAS network storage device, shown in a three-quarter 3D view with gentle perspective and real depth (you clearly see the front face plus the top and one side). It is an upright rounded-corner chassis sitting on a slim recessed base. Rich but tidy detail: the front face has a clean cloud emblem centered on it, two subtle horizontal drive-bay seam lines, and a slim vertical row of three small round status-LED dots near the right edge; the side face has a column of fine thin ventilation slots; soft rounded edges throughout. Render it with soft studio lighting: a gentle highlight along the top edge, a slightly darker tone on the top and side faces for dimension, and smooth subtle shading inside the faces (not flat, but no harsh gradients). Wrap the whole device, the cloud, the LEDs, and the vents in a bold, CHUNKY, even solid BLACK outline with smoothly rounded corners, plus crisp clean black interior lines for the seams and vents; the linework must stay clearly readable when the icon is shrunk to 16 by 16 pixels. No separate floating cloud, no signal waves, no badge, no text. Keep the device shape, 3D angle, detail, outline weight, and cloud identical to the connected and disconnected icons in this family.

State = CONNECTING: the NAS body is a vibrant yuzu yellow, a bright saturated warm citrus yellow #F5C518 on the lit front face with a slightly deeper amber-yellow on the shaded top and side faces for depth; the three status LEDs glow warm amber; the cloud emblem is white. Flat solid colours with only subtle shading, chunky black linework, transparent background, no text.
```

---

## Prompt 3 of 3, DISCONNECTED, save as `disconnected-source.png`

```
A single premium, professional app icon in a polished flat-3D illustration style (the quality of a top-tier macOS or Dribbble cloud-app icon), 1024 x 1024 pixels, on a FULLY TRANSPARENT background (real alpha, no background fill, no checkerboard, no border, no text, no watermark). Center the device with about 10 percent padding.

Subject: one detailed modern desktop NAS network storage device, shown in a three-quarter 3D view with gentle perspective and real depth (you clearly see the front face plus the top and one side). It is an upright rounded-corner chassis sitting on a slim recessed base. Rich but tidy detail: the front face has a clean cloud emblem centered on it, two subtle horizontal drive-bay seam lines, and a slim vertical row of three small round status-LED dots near the right edge; the side face has a column of fine thin ventilation slots; soft rounded edges throughout. Render it with soft studio lighting: a gentle highlight along the top edge, a slightly darker tone on the top and side faces for dimension, and smooth subtle shading. Wrap the whole device, the cloud, the LEDs, and the vents in a bold, CHUNKY, even solid BLACK outline with smoothly rounded corners, plus crisp clean black interior lines for the seams and vents; the linework must stay clearly readable when the icon is shrunk to 16 by 16 pixels. No separate floating cloud, no signal waves, no badge, no text. Keep the device shape, 3D angle, detail, outline weight, and cloud identical to the connected and connecting icons in this family.

State = DISCONNECTED: the whole NAS is greyed out and inactive, a desaturated cool light grey body with slightly darker grey on the top and side faces for depth, the status LEDs dark grey and unlit, the cloud emblem an empty white. Then draw ONE bold straight BLACK diagonal slash running from the upper-left down to the lower-right, straight across the entire device, in the same chunky black weight as the outline, exactly like the Microsoft OneDrive tray icon when you are signed out / not connected. Muted grey with chunky black linework, transparent background, no text.
```

---

## If the result has a background

If any image comes back with a solid or checkerboard background instead of real
transparency, regenerate that one and add "must have genuine alpha transparency,
absolutely no background fill" to the prompt. Colour reference: connected =
bright ocean green #11695f (the AppHub brand green); connecting = vibrant yuzu
yellow #F5C518; disconnected = greyed out, single black diagonal slash. Keep the
black outline chunky and the three icons identical apart from colour and slash.
