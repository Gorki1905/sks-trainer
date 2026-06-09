#!/usr/bin/env python3
"""Generate simple PWA icons (sailboat) into app/icons/."""
import os
from PIL import Image, ImageDraw

os.makedirs("docs/icons", exist_ok=True)


def make(size):
    img = Image.new("RGB", (size, size), (15, 32, 50))
    d = ImageDraw.Draw(img)
    s = size
    # water
    d.rectangle([0, int(s*0.72), s, s], fill=(33, 92, 120))
    # waves
    for i, y in enumerate([0.78, 0.86]):
        d.line([(0, int(s*y)), (s, int(s*y))], fill=(80, 150, 180), width=max(2, s//90))
    # mast
    mast_x = int(s*0.52)
    d.line([(mast_x, int(s*0.16)), (mast_x, int(s*0.72))], fill=(230, 238, 245), width=max(2, s//120))
    # main sail (triangle)
    d.polygon([(mast_x-int(s*0.02), int(s*0.18)),
               (mast_x-int(s*0.02), int(s*0.66)),
               (int(s*0.20), int(s*0.66))], fill=(61, 169, 252))
    # jib
    d.polygon([(mast_x+int(s*0.02), int(s*0.24)),
               (mast_x+int(s*0.02), int(s*0.66)),
               (int(s*0.80), int(s*0.66))], fill=(110, 200, 255))
    # hull
    d.polygon([(int(s*0.16), int(s*0.68)),
               (int(s*0.84), int(s*0.68)),
               (int(s*0.72), int(s*0.78)),
               (int(s*0.28), int(s*0.78))], fill=(20, 22, 28))
    return img


for sz, name in [(192, "icon-192.png"), (512, "icon-512.png"), (180, "apple-touch-icon.png"), (32, "favicon-32.png")]:
    make(sz).save(f"docs/icons/{name}")
print("Icons erzeugt:", os.listdir("docs/icons"))
