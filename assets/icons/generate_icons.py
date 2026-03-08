#!/usr/bin/env python3
"""
Generate all iOS/Web icon sizes from source-logo.png.

Strategy:
  - Do NOT auto-crop the source. The logo image already has appropriate
    black margins built in by the designer.
  - Resize the full source (with its natural padding) to LOGO_FILL of
    the target canvas.
  - Center on a pure black (#000000) square canvas.
  - Aspect ratio is NEVER altered (source must be square; if not, it is
    letterboxed symmetrically).
"""
from pathlib import Path
from PIL import Image

SCRIPT_DIR = Path(__file__).parent
SRC        = SCRIPT_DIR / "source-logo.png"

# Logo (including its built-in padding) fills this fraction of each icon.
# 0.85 → 7.5 % black margin added on every side by us,
# plus whatever natural padding the source image already contains.
LOGO_FILL = 0.85

ICONS = [
    # AppIcon.appiconset (Xcode)
    ("AppIcon.appiconset/icon-20@2x.png",    40),
    ("AppIcon.appiconset/icon-20@3x.png",    60),
    ("AppIcon.appiconset/icon-29@2x.png",    58),
    ("AppIcon.appiconset/icon-29@3x.png",    87),
    ("AppIcon.appiconset/icon-38@2x.png",    76),
    ("AppIcon.appiconset/icon-38@3x.png",   114),
    ("AppIcon.appiconset/icon-40@2x.png",    80),
    ("AppIcon.appiconset/icon-40@3x.png",   120),
    ("AppIcon.appiconset/icon-60@2x.png",   120),
    ("AppIcon.appiconset/icon-60@3x.png",   180),
    ("AppIcon.appiconset/icon-64@2x.png",   128),
    ("AppIcon.appiconset/icon-64@3x.png",   192),
    ("AppIcon.appiconset/icon-76@2x.png",   152),
    ("AppIcon.appiconset/icon-83.5@2x.png", 167),
    ("AppIcon.appiconset/icon-1024.png",   1024),
    # Web / PWA
    ("apple-touch-icon.png",               180),
    ("favicon-32x32.png",                   32),
    ("favicon-16x16.png",                   16),
]


def make_icon(src: Image.Image, out_path: Path, icon_size: int, fill: float):
    """
    Place src (with its natural padding) onto a black square canvas.
    The longer side of src maps to (icon_size * fill) pixels.
    Aspect ratio is strictly preserved.
    """
    src_w, src_h = src.size
    # Scale so the longer side equals inner_size
    inner = int(icon_size * fill)
    scale  = inner / max(src_w, src_h)
    new_w  = round(src_w * scale)
    new_h  = round(src_h * scale)

    resized = src.resize((new_w, new_h), Image.LANCZOS)

    canvas   = Image.new("RGB", (icon_size, icon_size), (0, 0, 0))
    x_offset = (icon_size - new_w) // 2
    y_offset = (icon_size - new_h) // 2
    canvas.paste(resized, (x_offset, y_offset))

    out_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(str(out_path), "PNG", optimize=True)


def main():
    src = Image.open(SRC).convert("RGB")
    print(f"Source : {SRC.name}  {src.size[0]}x{src.size[1]}")
    print(f"Fill   : {LOGO_FILL:.0%}  (margin each side: {(1-LOGO_FILL)/2:.1%})")

    for rel_path, icon_size in ICONS:
        out = SCRIPT_DIR / rel_path
        make_icon(src, out, icon_size, LOGO_FILL)
        result = Image.open(out)
        ok = "OK" if result.size == (icon_size, icon_size) else "NG"
        print(f"  [{ok}] {out.name:<35} {result.size[0]}x{result.size[1]}")

    print(f"\nDone. {len(ICONS)} icons generated.")


if __name__ == "__main__":
    main()
