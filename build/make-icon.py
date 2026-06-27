#!/usr/bin/env python3
"""Generate build/icon.png — the Terminator app icon.

A rounded terminal window with a terracotta ">_" prompt, on the app's dark
charcoal background. Drawn with Pillow primitives (no SVG/font deps) and
super-sampled 2x for clean anti-aliased edges.

Run:  python3 build/make-icon.py   ->  writes build/icon.png (512x512)
"""
from pathlib import Path
from PIL import Image, ImageDraw

SIZE = 512
SS = 2  # super-sample factor
S = SIZE * SS

BG = (26, 25, 23)        # #1a1917  app background
PANEL = (36, 34, 32)     # #242220  terminal window
PANEL_BORDER = (58, 53, 47)
BAR = (29, 28, 25)       # #1d1c19  title bar
HAIR = (48, 44, 39)
ACCENT = (217, 119, 87)  # #d97757  terracotta
DOT1 = (217, 119, 87)
DOT2 = (110, 106, 96)
DOT3 = (77, 73, 64)


def s(v: float) -> int:
    return int(round(v * SS))


def rline(draw, p0, p1, width, fill):
    """A thick line with rounded caps."""
    draw.line([s(p0[0]), s(p0[1]), s(p1[0]), s(p1[1])], fill=fill, width=s(width))
    r = s(width) / 2
    for (x, y) in (p0, p1):
        draw.ellipse([s(x) - r, s(y) - r, s(x) + r, s(y) + r], fill=fill)


def main() -> None:
    img = Image.new("RGB", (S, S), BG)
    d = ImageDraw.Draw(img)

    # Terminal window panel
    win = (96, 132, 416, 380)  # left, top, right, bottom
    d.rounded_rectangle(
        [s(win[0]), s(win[1]), s(win[2]), s(win[3])],
        radius=s(30), fill=PANEL, outline=PANEL_BORDER, width=s(2),
    )

    # Title bar (top strip of the window) + divider
    bar_bottom = win[1] + 46
    d.rounded_rectangle(
        [s(win[0]), s(win[1]), s(win[2]), s(bar_bottom + 30)],
        radius=s(30), fill=BAR,
    )
    # square off the bottom of the bar so only the top corners are round
    d.rectangle([s(win[0]), s(bar_bottom), s(win[2]), s(bar_bottom + 30)], fill=PANEL)
    d.line([s(win[0]), s(bar_bottom), s(win[2]), s(bar_bottom)], fill=HAIR, width=s(2))

    # Traffic-light dots
    cy = win[1] + 23
    for cx, col in ((124, DOT1), (150, DOT2), (176, DOT3)):
        r = s(7)
        d.ellipse([s(cx) - r, s(cy) - r, s(cx) + r, s(cy) + r], fill=col)

    # ">" chevron prompt
    rline(d, (168, 228), (224, 282), width=22, fill=ACCENT)
    rline(d, (224, 282), (168, 336), width=22, fill=ACCENT)
    # "_" underscore / cursor
    rline(d, (250, 330), (344, 330), width=22, fill=ACCENT)

    out = img.resize((SIZE, SIZE), Image.LANCZOS)
    dest = Path(__file__).resolve().parent / "icon.png"
    out.save(dest, "PNG")
    print(f"wrote {dest} ({SIZE}x{SIZE})")


if __name__ == "__main__":
    main()
