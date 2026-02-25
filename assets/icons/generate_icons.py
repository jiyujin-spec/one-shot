#!/usr/bin/env python3
"""
Generate all iOS/Web icon sizes from source-logo.png.
Auto-crops black margins, centers the logo, and applies consistent padding.
"""
from pathlib import Path
from PIL import Image
import numpy as np

SCRIPT_DIR = Path(__file__).parent
SRC = SCRIPT_DIR / "source-logo.png"
APPICONSET_DIR = SCRIPT_DIR / "AppIcon.appiconset"

# padding_ratio: logo が占める割合 (0.85 = 枠の 85% を logo, 7.5% ずつ余白)
LOGO_FILL = 0.85

# (output_path_relative_to_SCRIPT_DIR, size_px)
ICONS = [
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
    ("apple-touch-icon.png",               180),
    ("favicon-32x32.png",                   32),
    ("favicon-16x16.png",                   16),
]


def crop_to_content(img: Image.Image, threshold: int = 30):
    """
    黒背景を除いたコンテンツ領域を正方形でクロップして返す。
    外れ値ピクセル（ウォーターマーク等）の影響を排除するため
    コンテンツ画素の重心＋パーセンタイルで境界を決定する。
    """
    arr = np.array(img.convert("RGB"))
    mask = ~((arr[:, :, 0] < threshold) &
             (arr[:, :, 1] < threshold) &
             (arr[:, :, 2] < threshold))

    ys, xs = np.where(mask)

    # 99パーセンタイルで外れ値除去
    p1, p99 = 1, 99
    rmin = int(np.percentile(ys, p1))
    rmax = int(np.percentile(ys, p99))
    cmin = int(np.percentile(xs, p1))
    cmax = int(np.percentile(xs, p99))

    # 重心を中心にして正方形クロップ
    cx = (cmin + cmax) // 2
    cy = (rmin + rmax) // 2
    half = max(rmax - rmin, cmax - cmin) // 2

    left   = max(cx - half, 0)
    top    = max(cy - half, 0)
    right  = min(cx + half, img.width)
    bottom = min(cy + half, img.height)

    return img.crop((left, top, right, bottom))


def make_icon(cropped: Image.Image, out_path: Path, size: int, fill: float):
    """指定サイズのアイコンを生成。fill 比率でロゴをセンタリング。"""
    canvas = Image.new("RGB", (size, size), (0, 0, 0))
    inner = int(size * fill)
    resized = cropped.resize((inner, inner), Image.LANCZOS)
    offset = (size - inner) // 2
    canvas.paste(resized, (offset, offset))
    out_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(str(out_path), "PNG", optimize=True)


def main():
    src = Image.open(SRC)
    print(f"Source: {SRC.name}  {src.size[0]}x{src.size[1]}")

    cropped = crop_to_content(src)
    print(f"Cropped to content: {cropped.size[0]}x{cropped.size[1]}  (fill={LOGO_FILL})")

    for rel_path, size in ICONS:
        out = SCRIPT_DIR / rel_path
        make_icon(cropped, out, size, LOGO_FILL)
        print(f"  {out.name}  {size}x{size}")

    print(f"\nDone. {len(ICONS)} files updated.")


if __name__ == "__main__":
    main()
