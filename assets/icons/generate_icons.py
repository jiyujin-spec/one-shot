#!/usr/bin/env python3
"""
Generate all required iOS App Icon PNG sizes from icon-source.svg.
Usage: python3 generate_icons.py
Requires: Pillow, cairosvg  OR  Pillow + rsvg-convert
"""
import os
import subprocess
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
SVG_SOURCE = SCRIPT_DIR / "icon-source.svg"
APPICONSET_DIR = SCRIPT_DIR / "AppIcon.appiconset"

# (filename, size_px)
ICONS = [
    ("icon-20@2x.png",    40),
    ("icon-20@3x.png",    60),
    ("icon-29@2x.png",    58),
    ("icon-29@3x.png",    87),
    ("icon-38@2x.png",    76),
    ("icon-38@3x.png",   114),
    ("icon-40@2x.png",    80),
    ("icon-40@3x.png",   120),
    ("icon-60@2x.png",   120),
    ("icon-60@3x.png",   180),
    ("icon-64@2x.png",   128),
    ("icon-64@3x.png",   192),
    ("icon-76@2x.png",   152),
    ("icon-83.5@2x.png", 167),
    ("icon-1024.png",   1024),
    # Web / PWA
    ("../apple-touch-icon.png",  180),
    ("../favicon-32x32.png",      32),
    ("../favicon-16x16.png",      16),
]

def generate_with_cairosvg(svg_path, out_path, size):
    import cairosvg
    cairosvg.svg2png(
        url=str(svg_path),
        write_to=str(out_path),
        output_width=size,
        output_height=size,
    )

def generate_with_pillow_svg(svg_path, out_path, size):
    """Fallback: render SVG via rsvg-convert if available."""
    tmp = out_path.with_suffix(".tmp.png")
    subprocess.run(
        ["rsvg-convert", "-w", str(size), "-h", str(size), "-o", str(tmp), str(svg_path)],
        check=True
    )
    tmp.rename(out_path)

def main():
    # Try to import cairosvg first
    renderer = None
    try:
        import cairosvg  # noqa: F401
        renderer = "cairosvg"
        print("Using cairosvg renderer")
    except ImportError:
        pass

    if renderer is None:
        try:
            subprocess.run(["rsvg-convert", "--version"], capture_output=True, check=True)
            renderer = "rsvg"
            print("Using rsvg-convert renderer")
        except (FileNotFoundError, subprocess.CalledProcessError):
            pass

    if renderer is None:
        print("ERROR: Install cairosvg (pip3 install cairosvg) or librsvg (apt install librsvg2-bin)")
        sys.exit(1)

    APPICONSET_DIR.mkdir(parents=True, exist_ok=True)

    for filename, size in ICONS:
        out = (APPICONSET_DIR / filename).resolve()
        out.parent.mkdir(parents=True, exist_ok=True)
        print(f"  Generating {filename} ({size}x{size})...")
        if renderer == "cairosvg":
            generate_with_cairosvg(SVG_SOURCE, out, size)
        else:
            generate_with_pillow_svg(SVG_SOURCE, out, size)

    print(f"\nDone! {len(ICONS)} icons generated in {APPICONSET_DIR.parent}")

if __name__ == "__main__":
    main()
