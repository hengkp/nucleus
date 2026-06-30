# MapDrive tray icon set, single Codex image-generation prompt

Hand the prompt in the fenced block below to Codex as one task. It tells Codex to
use the GPT image 2.0 image tool to produce the three status icons. Designed from
the ground up for a system tray: minimal, flat, single-accent, high-contrast,
legible at 16 px (per the power-design and awesome-design-md guides), not a
detailed 3D render.

```
TASK: Using the GPT image 2.0 image-generation tool directly (call the tool; do NOT write Python or any code, and do not download anything), create three system-tray status icons for a cloud network-drive app and save them in the current folder as connected-source.png, connecting-source.png, and disconnected-source.png. Generate one image per state, three images total.

THESE ARE TINY TRAY ICONS, SO DESIGN FOR 16x16 PIXELS, NOT FOR DETAIL. Follow minimal professional icon principles: one single idea, one accent colour, maximum contrast, generous negative space, flat design, and ruthless removal of ornament. Hard rules: NO 3D, NO perspective or isometric view, NO gradients, NO drop shadows, NO drive bays, vents, screws, LED dots, or texture, NO clip-art look, NO outline frame around the whole picture, NO background, NO text or letters. Aim for the clean, confident calibre of Apple, Stripe, or Linear system glyphs.

THE MARK (must be pixel-for-pixel identical in all three icons, only the colour changes plus the slash on the third): one single flat, front-on network drive, drawn as a bold horizontal rounded rectangle with a friendly modern external-drive proportion (about 3 wide to 2 tall, soft rounded corners), filled with one solid flat colour. The ONLY interior detail is a simple minimal cloud symbol knocked out in clean white, centred on the drive. Keep it one bold high-contrast silhouette, perfectly centred, with about 14 percent empty padding on all sides. Same shape, same cloud, same size, same position every time.

THREE STATES:
1) connected-source.png: drive filled solid bright ocean green, hex #11695f (the app brand green); white cloud.
2) connecting-source.png: drive filled solid vibrant yuzu yellow, hex #F5C518; white cloud.
3) disconnected-source.png: drive filled solid muted neutral grey, hex #9AA7A4 (clearly "off", no status colour); white cloud; then draw ONE bold straight diagonal slash from the top-left to the bottom-right across the whole drive, like the OneDrive tray icon when signed out.

OUTPUT for each: a single 1024 x 1024 PNG on a FULLY TRANSPARENT background (real alpha, no fill). If the tool returns an opaque or checkerboard image, key out the flat background to real transparency before saving. Save the three files with the exact names above in this folder.
```
