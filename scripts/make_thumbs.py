#!/usr/bin/env python3
"""
Write small WebP previews of the bundled example photos, so the landing page and the view strip
do not download full 2000 px JPEGs for 200 px tiles.

For every web/public/examples/<id>/:
  card.webp                  landing card (ExamplePicker): 552 px wide, enough for the card widths
                             (168-204 CSS px, 2:1 object-cover box) at up to 3x on phones and 2x on
                             desktops; every photo is narrower than 2:1, so the width decides the crop.
                             The landing stage also shows it while the full photo loads.
  thumb.webp                 view strip tile (ViewStrip, 56x42 CSS px object-cover) at 3x:
                             scaled to cover 168x126
  views/<viewId>/thumb.webp  same, for each extra view

and adds "card": "card.webp" (after "thumbnail") to that example's entry in index.json.
scripts/build_scene.py emits the same field when card.webp exists, so the order of the two
scripts does not matter.

Needs only `cwebp` (libwebp) on PATH; JPEG sizes are read from the file header.

Usage:
    python3 scripts/make_thumbs.py                    # all examples
    python3 scripts/make_thumbs.py nyc-ridge-street   # some
"""
from __future__ import annotations

import json
import math
import struct
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXAMPLES_DIR = ROOT / "web" / "public" / "examples"

CARD_W = 552
THUMB_BOX = (168, 126)
QUALITY = 80


def jpeg_size(path: Path) -> tuple[int, int]:
    """(width, height) from the first SOFn marker of a baseline/progressive JPEG."""
    data = path.read_bytes()
    if data[:2] != b"\xff\xd8":
        raise SystemExit(f"{path}: not a JPEG")
    i = 2
    while i + 4 <= len(data):
        if data[i] != 0xFF:
            i += 1
            continue
        marker = data[i + 1]
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7 or marker == 0xFF:
            i += 1 if marker == 0xFF else 2
            continue
        (seg_len,) = struct.unpack(">H", data[i + 2:i + 4])
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            h, w = struct.unpack(">HH", data[i + 5:i + 9])
            return w, h
        i += 2 + seg_len
    raise SystemExit(f"{path}: no SOF marker")


def cwebp(src: Path, dst: Path, w: int, h: int) -> None:
    subprocess.run(["cwebp", "-quiet", "-q", str(QUALITY), "-m", "6", "-sharp_yuv", "-metadata", "none",
                    "-resize", str(w), str(h), str(src), "-o", str(dst)], check=True)
    print(f"  {dst.relative_to(ROOT)}  {w}x{h}  {dst.stat().st_size // 1024} KB")


def card(photo: Path) -> None:
    w, h = jpeg_size(photo)
    cwebp(photo, photo.with_name("card.webp"), CARD_W, round(h * CARD_W / w))


def thumb(photo: Path) -> None:
    w, h = jpeg_size(photo)
    s = max(THUMB_BOX[0] / w, THUMB_BOX[1] / h)
    # ceil so the box is always covered; the epsilon keeps exact fits (2000x1500 -> 168x126) exact.
    cwebp(photo, photo.with_name("thumb.webp"), math.ceil(w * s - 1e-6), math.ceil(h * s - 1e-6))


def main() -> None:
    only = set(sys.argv[1:])
    index_path = EXAMPLES_DIR / "index.json"
    index = json.loads(index_path.read_text())
    out = []
    for entry in index:
        eid = entry["id"]
        d = EXAMPLES_DIR / eid
        if not only or eid in only:
            print(eid)
            card(d / "photo.jpg")
            thumb(d / "photo.jpg")
            for photo in sorted(d.glob("views/*/photo.jpg")):
                thumb(photo)
        # Re-insert "card" right after "thumbnail", where build_scene.py puts it.
        rebuilt = {}
        for k, v in entry.items():
            if k == "card":
                continue
            rebuilt[k] = v
            if k == "thumbnail" and (d / "card.webp").exists():
                rebuilt["card"] = "card.webp"
        out.append(rebuilt)
    index_path.write_text(json.dumps(out, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
