#!/usr/bin/env python3
"""Render the SISP MapDrive Windows tray-icon set.

The mark is the MapDrive brand glyph (hexagon network-node -> external drive), the same
family as the app icon and logo, tuned for the system tray: bold, flat, legible at 16 px.

  connected               teal drive + green node + solid link      (colour, reads on any taskbar)
  disconnected            slate mono, hollow node, broken link      (light taskbar)
  disconnected-darktheme  white mono, hollow node, broken link      (dark taskbar)

Geometry is drawn on a 32-unit grid, supersampled per output size for clean anti-aliasing,
then packed into multi-resolution .ico files (BMP frames < 256 px, PNG frame at 256 px for
maximum compatibility with System.Drawing.Icon). Only dependency is Pillow:

    python generate-tray-icons.py            # writes the set next to this script
    python generate-tray-icons.py --preview  # also writes _preview.png (light/dark contact sheet)
"""
import io
import os
import struct
import sys

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))

TEAL  = (17, 105, 95, 255)     # #11695f brand teal (drive)
GREEN = (46, 155, 95, 255)     # #2e9b5f connected green (node)
KEY   = (12, 36, 34, 255)      # #0c2422 deep slate keyline
WHITE = (255, 255, 255, 255)
SLATE = (19, 26, 25, 255)      # #131a19 mono glyph for a light taskbar
PAPER = (247, 249, 249, 255)   # #f7f9f9 mono glyph for a dark taskbar

HEX = [(16, 3.0), (20.5, 5.6), (20.5, 10.8), (16, 13.4), (11.5, 10.8), (11.5, 5.6)]
ICO_SIZES = [16, 20, 24, 32, 48, 64, 256]


def _render_dim(size):
    return max(min(size * 16, 2048), size * 2)


def draw_icon(size, state, mono=None):
    R = _render_dim(size)
    k = R / 32.0
    img = Image.new("RGBA", (R, R), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    hexpts = [(x * k, y * k) for x, y in HEX]

    def W(w):
        return max(1, int(round(w * k)))

    def circle(cx, cy, r, fill=None):
        d.ellipse([(cx - r) * k, (cy - r) * k, (cx + r) * k, (cy + r) * k], fill=fill)

    def seg(p1, p2, color, wd, cap=False):
        d.line([p1[0] * k, p1[1] * k, p2[0] * k, p2[1] * k], fill=color, width=W(wd))
        if cap:
            r = wd / 2.0
            circle(p1[0], p1[1], r, fill=color)
            circle(p2[0], p2[1], r, fill=color)

    drive = [4.6 * k, 18.6 * k, 27.4 * k, 28.0 * k]
    rad = 2.4 * k

    if state == "connected":
        seg((16, 12), (16, 19.6), TEAL, 2.9)                      # link, tucked under node + drive
        d.rounded_rectangle(drive, radius=rad, fill=TEAL, outline=KEY, width=W(0.7))
        d.polygon(hexpts, fill=GREEN)
        d.line(hexpts + [hexpts[0]], fill=KEY, width=W(0.7), joint="curve")
        circle(16, 8.2, 1.7, fill=WHITE)                          # node core
        circle(22.6, 23.3, 1.7, fill=WHITE)                       # drive LED
    else:
        m = mono
        d.line(hexpts + [hexpts[0]], fill=m, width=W(2.2), joint="curve")   # hollow node
        seg((16, 12.0), (16, 14.7), m, 2.4, cap=True)             # broken link (upper)
        seg((16, 17.0), (16, 18.8), m, 2.4, cap=True)             # broken link (lower)
        d.rounded_rectangle(drive, radius=rad, fill=m)            # solid drive
        circle(16, 8.2, 1.35, fill=m)                             # node core

    return img.resize((size, size), Image.LANCZOS)


def _bmp_frame(im):
    w, h = im.size
    px = im.load()
    xor = bytearray()
    for y in range(h - 1, -1, -1):
        for x in range(w):
            r, g, b, a = px[x, y]
            xor += bytes((b, g, r, a))
    row = ((w + 31) // 32) * 4
    header = struct.pack("<IiiHHIIiiII", 40, w, h * 2, 1, 32, 0, 0, 0, 0, 0, 0)
    return header + bytes(xor) + bytes(row * h)


def pack_ico(state, mono=None):
    frames = []
    for s in ICO_SIZES:
        im = draw_icon(s, state, mono)
        if s >= 256:
            buf = io.BytesIO(); im.save(buf, "PNG"); data = buf.getvalue()
        else:
            data = _bmp_frame(im)
        frames.append((s, data))
    out = struct.pack("<HHH", 0, 1, len(frames))
    offset = 6 + 16 * len(frames)
    for s, data in frames:
        wb = s if s < 256 else 0
        out += struct.pack("<BBBBHHII", wb, wb, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
    for _, data in frames:
        out += data
    return out


STATES = [
    ("connected",              "connected",    None),
    ("disconnected",           "disconnected", SLATE),
    ("disconnected-darktheme", "disconnected", PAPER),
]


def build():
    os.makedirs(os.path.join(HERE, "png"), exist_ok=True)
    for name, state, mono in STATES:
        with open(os.path.join(HERE, name + ".ico"), "wb") as f:
            f.write(pack_ico(state, mono))
        draw_icon(256, state, mono).save(os.path.join(HERE, name + ".png"))
        draw_icon(1024, state, mono).save(os.path.join(HERE, name + "-source.png"))
        draw_icon(256, state, mono).save(os.path.join(HERE, name + "-base.png"))
        draw_icon(256, state, mono).save(os.path.join(HERE, "png", name + ".png"))
        print("wrote", name)


def preview():
    sizes = [16, 24, 32, 48]
    pad, gap, cellw = 16, 18, 120
    rows = STATES
    Wt = pad * 2 + len(sizes) * cellw
    Ht = pad * 2 + len(rows) * (64 + gap)
    sheet = Image.new("RGBA", (Wt, Ht), (255, 255, 255, 255))
    draw = ImageDraw.Draw(sheet)
    for ri, (label, state, mono) in enumerate(rows):
        y0 = pad + ri * (64 + gap)
        bg = (30, 30, 30, 255) if "darktheme" in label else (238, 240, 240, 255)
        draw.rounded_rectangle([pad - 8, y0 - 8, Wt - pad + 8, y0 + 72], radius=10, fill=bg)
        for ci, s in enumerate(sizes):
            ic = draw_icon(s, state, mono)
            sheet.alpha_composite(ic, (pad + ci * cellw + (cellw - s) // 2, y0 + (64 - s) // 2))
    sheet.save(os.path.join(HERE, "_preview.png"))
    print("wrote _preview.png")


if __name__ == "__main__":
    build()
    if "--preview" in sys.argv:
        preview()
