#!/usr/bin/env python3
"""
Generate web/og.png — the Open Graph card, 1200x630.

    python3 tools/make-og.py

-------------------------------------------------------------------------------
WHY THIS IS A SCRIPT AND NOT A BINARY SOMEBODY DROPPED IN
-------------------------------------------------------------------------------
A social card is the one image most people will ever see of this project, and it
carries two strings that must not drift from the site: the wordmark and the
category statement. Committing a PNG with no source means the next person to
change the tagline has no way to regenerate it, so it silently goes stale --
which is the same failure mode as a version stamp that lags, on a surface with a
wider audience than the README.

The composition is deliberately not a product explanation. It is the wordmark,
the category statement, and the one visual idea the site is built on: a line
that decides, sitting between the name and what it is. Nothing else. An OG card
is read in under a second in a timeline, and a diagram of the architecture would
be illegible at the size Slack renders it.

Colours are taken from web/styles.css and must stay in step with it:
    --paper  #fbfaf8   --ink  #14161a   --ink-2  #3d434d
    --rule   #e2dfd9   --allow (the deciding line)  #0f766e
"""

from __future__ import annotations
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

W, H = 1200, 630
PAPER = (251, 250, 248)
INK = (20, 22, 26)
INK_2 = (61, 67, 77)
RULE = (226, 223, 217)
ALLOW = (15, 118, 110)

WORDMARK = "Filelayer"
TAGLINE = "The file layer for SaaS applications."

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "web" / "og.png"

# Lato is the closest available face to the site's system-sans rendering.
# Ordered by preference; the first that loads wins, so this works on a machine
# with a different font set rather than failing.
FACES = {
    "bold": [
        "/usr/share/fonts/truetype/lato/Lato-Bold.ttf",
        "/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    ],
    "regular": [
        "/usr/share/fonts/truetype/lato/Lato-Regular.ttf",
        "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ],
}


def font(kind: str, size: int) -> ImageFont.FreeTypeFont:
    for path in FACES[kind]:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    raise SystemExit(f"make-og: no usable {kind} font found. Tried:\n  " + "\n  ".join(FACES[kind]))


def rounded_mark(d: ImageDraw.ImageDraw, x: int, y: int, size: int) -> None:
    """The logo: three rules in a rounded square, the middle one deciding."""
    d.rounded_rectangle([x, y, x + size, y + size], radius=int(size * 0.22), fill=INK)
    inset = int(size * 0.22)
    thickness = max(2, int(size * 0.075))
    for i, colour in enumerate((PAPER, ALLOW, PAPER)):
        ly = y + inset + i * int((size - 2 * inset) / 2)
        d.rounded_rectangle(
            [x + inset, ly - thickness // 2, x + size - inset, ly + thickness // 2],
            radius=thickness // 2,
            fill=colour,
        )


def main() -> int:
    img = Image.new("RGB", (W, H), PAPER)
    d = ImageDraw.Draw(img)

    pad = 96
    f_word = font("bold", 132)
    f_tag = font("regular", 46)

    # --- the mark, top left -------------------------------------------------
    rounded_mark(d, pad, pad - 4, 78)

    # --- wordmark -----------------------------------------------------------
    word_y = 246
    d.text((pad, word_y), WORDMARK, font=f_word, fill=INK)
    wl, wt, wr, wb = d.textbbox((pad, word_y), WORDMARK, font=f_word)

    # --- the deciding line, between the name and what it is -----------------
    line_y = wb + 44
    line_h = 7
    d.rounded_rectangle([pad, line_y, wr, line_y + line_h], radius=line_h // 2, fill=ALLOW)

    # It continues, paler, to the edge: the layer does not stop at the wordmark.
    d.rectangle([wr + 22, line_y + line_h // 2 - 1, W - pad, line_y + line_h // 2 + 1], fill=RULE)

    # --- tagline ------------------------------------------------------------
    d.text((pad, line_y + line_h + 42), TAGLINE, font=f_tag, fill=INK_2)

    img.save(OUT, "PNG", optimize=True)

    size_kb = OUT.stat().st_size / 1024
    print(f"make-og: wrote {OUT.relative_to(ROOT)} — {img.width}x{img.height}, {size_kb:.1f} kB")
    if (img.width, img.height) != (1200, 630):
        print("make-og: WRONG DIMENSIONS", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
