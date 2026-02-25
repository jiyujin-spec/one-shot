#!/usr/bin/env python3
"""
Generate all iOS/Web icon sizes from source-logo.png.

Rules:
  - Aspect ratio is NEVER changed (no stretching).
  - Logo is centered on a pure black (#000000) square canvas.
  - Black margins in the source image are auto-cropped.
  - Outlier pixels (watermarks etc.) are ignored via percentile detection.
"""
from pathlib import Path
from PIL import Image
import numpy as np

SCRIPT_DIR = Path(__file__).parent
SRC        = SCRIPT_DIR / "source-logo.png"

# Logo occupies this fraction of each icon side (0.82 → 9% black margin each side)
LOGO_FILL = 0.82

ICONS = [
    # AppIcon.appiconset
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


def extract_logo(img: Image.Image, threshold: int = 30) -> Image.Image:
    """
    ① 黒背景を除いたコンテンツの中心・サイズをパーセンタイルで検出
    ② 正方形でクロップ（境界クランプ後も正方形を保証）
    ③ 結果画像を正方形で返す
    """
    rgb = img.convert("RGB")
    arr = np.array(rgb)

    mask = ~((arr[:, :, 0] < threshold) &
             (arr[:, :, 1] < threshold) &
             (arr[:, :, 2] < threshold))
    ys, xs = np.where(mask)

    # 外れ値除去（ウォーターマーク等を無視）
    rmin = int(np.percentile(ys, 1))
    rmax = int(np.percentile(ys, 99))
    cmin = int(np.percentile(xs, 1))
    cmax = int(np.percentile(xs, 99))

    content_h = rmax - rmin
    content_w = cmax - cmin
    side      = max(content_h, content_w)     # 長辺に合わせた正方形サイズ

    cx = (cmin + cmax) // 2
    cy = (rmin + rmax) // 2
    half = side // 2

    # クロップ座標を計算（クランプ前）
    left   = cx - half
    top    = cy - half
    right  = cx + half
    bottom = cy + half

    # 画像範囲外にはみ出る場合、反対側もずらして正方形を維持
    if left < 0:
        right -= left   # right を正方向にシフト
        left   = 0
    if top < 0:
        bottom -= top
        top    = 0
    if right > img.width:
        left  -= (right - img.width)
        right  = img.width
    if bottom > img.height:
        top   -= (bottom - img.height)
        bottom = img.height

    # 最終クランプ（念のため）
    left, top, right, bottom = (max(0, left), max(0, top),
                                 min(img.width, right), min(img.height, bottom))

    cropped = rgb.crop((left, top, right, bottom))

    # 万一クロップが正方形でない場合に黒パディングで正方形化
    cw, ch = cropped.size
    if cw != ch:
        square_side = max(cw, ch)
        square = Image.new("RGB", (square_side, square_side), (0, 0, 0))
        square.paste(cropped, ((square_side - cw) // 2, (square_side - ch) // 2))
        cropped = square

    return cropped


def make_icon(logo_square: Image.Image, out_path: Path, icon_size: int, fill: float):
    """
    正方形ロゴを icon_size × icon_size の黒キャンバスに
    アスペクト比を保ったままセンタリングして保存する。
    """
    # ロゴが収まる内側サイズ
    inner = int(icon_size * fill)

    # アスペクト比を維持してリサイズ（logo_square は正方形なのでそのまま）
    logo_w, logo_h = logo_square.size
    scale = inner / max(logo_w, logo_h)
    new_w = round(logo_w * scale)
    new_h = round(logo_h * scale)
    resized = logo_square.resize((new_w, new_h), Image.LANCZOS)

    # 黒キャンバスにセンタリングして貼り付け
    canvas = Image.new("RGB", (icon_size, icon_size), (0, 0, 0))
    x_offset = (icon_size - new_w) // 2
    y_offset = (icon_size - new_h) // 2
    canvas.paste(resized, (x_offset, y_offset))

    out_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(str(out_path), "PNG", optimize=True)


def main():
    src = Image.open(SRC)
    print(f"Source : {SRC.name}  {src.size[0]}x{src.size[1]}")

    logo = extract_logo(src)
    lw, lh = logo.size
    print(f"Logo   : {lw}x{lh}  (square={lw==lh})  fill={LOGO_FILL}")

    for rel_path, icon_size in ICONS:
        out = SCRIPT_DIR / rel_path
        make_icon(logo, out, icon_size, LOGO_FILL)
        # 検証
        result = Image.open(out)
        rw, rh = result.size
        ok = "OK" if rw == rh == icon_size else "NG"
        print(f"  [{ok}] {out.name}  {rw}x{rh}")

    print(f"\nDone. {len(ICONS)} icons generated.")


if __name__ == "__main__":
    main()
