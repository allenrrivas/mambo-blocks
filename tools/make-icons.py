"""
make-icons.py — generate favicon.ico and apple-touch-icon.png.

Pillow is not a dependency of this project, so the PNG encoder and the ICO
container are written by hand on top of zlib. Run it only when the icon
design changes; the outputs are checked in.

    python tools/make-icons.py

The design is a top-down quadcopter: four rotors, four arms, a body. It has to
survive being 16 pixels wide, so it is drawn at 4x and downsampled rather than
aliased into mush. Geometry matches favicon.svg.
"""

import math
import pathlib
import struct
import zlib

ROOT = pathlib.Path(__file__).resolve().parent.parent

BG = (0x25, 0x63, 0xEB)     # --accent from app.css
FG = (0xFF, 0xFF, 0xFF)
SS = 4                       # supersampling factor

# Geometry in a 32-unit square, shared with favicon.svg.
ROTORS = [(8.5, 8.5), (23.5, 8.5), (8.5, 23.5), (23.5, 23.5)]
ROTOR_R = 3.9
ARM_W = 3.0        # 1px at 16px vanished; 1.5px survives
BODY = (16.0, 16.0, 8.6, 8.6, 2.2)   # cx, cy, w, h, r


def sdf_round_rect(x, y, cx, cy, w, h, r):
    qx = abs(x - cx) - (w / 2 - r)
    qy = abs(y - cy) - (h / 2 - r)
    return math.hypot(max(qx, 0.0), max(qy, 0.0)) + min(max(qx, qy), 0.0) - r


def sdf_circle(x, y, cx, cy, r):
    return math.hypot(x - cx, y - cy) - r


def sdf_segment(x, y, ax, ay, bx, by, width):
    vx, vy = bx - ax, by - ay
    wx, wy = x - ax, y - ay
    denom = vx * vx + vy * vy
    t = 0.0 if denom == 0 else max(0.0, min(1.0, (wx * vx + wy * vy) / denom))
    return math.hypot(wx - t * vx, wy - t * vy) - width / 2


def sample(x, y):
    """Colour at a point in 32-unit space, or None for transparent."""
    if sdf_round_rect(x, y, 16, 16, 32, 32, 7.0) > 0:
        return None

    for cx, cy in ROTORS:
        if sdf_circle(x, y, cx, cy, ROTOR_R) <= 0:
            return FG
        if sdf_segment(x, y, 16, 16, cx, cy, ARM_W) <= 0:
            return FG
    if sdf_round_rect(x, y, *BODY) <= 0:
        return FG
    return BG


def render(size):
    """RGBA bytes, supersampled and box-filtered down to `size`."""
    rows = []
    step = 32.0 / (size * SS)
    for py in range(size):
        row = bytearray()
        for px in range(size):
            r = g = b = a = 0
            for sy in range(SS):
                for sx in range(SS):
                    x = (px * SS + sx + 0.5) * step
                    y = (py * SS + sy + 0.5) * step
                    c = sample(x, y)
                    if c is not None:
                        # Premultiply so edges do not fringe when averaged.
                        r += c[0]; g += c[1]; b += c[2]; a += 255
            n = SS * SS
            if a == 0:
                row += bytes(4)
            else:
                alpha = a // n
                # Un-premultiply: the colour sum is over covered samples only.
                covered = a / 255
                row += bytes((round(r / covered), round(g / covered),
                              round(b / covered), alpha))
        rows.append(bytes(row))
    return rows


def png(size, rows):
    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c))

    raw = b"".join(b"\x00" + r for r in rows)   # filter type 0 per scanline
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9))
            + chunk(b"IEND", b""))


def ico(images):
    """ICO container holding PNG images (supported by every modern browser)."""
    header = struct.pack("<HHH", 0, 1, len(images))
    offset = len(header) + 16 * len(images)
    entries, blobs = b"", b""
    for size, data in images:
        entries += struct.pack("<BBBBHHII",
                               size if size < 256 else 0,
                               size if size < 256 else 0,
                               0, 0, 1, 32, len(data), offset)
        blobs += data
        offset += len(data)
    return header + entries + blobs


def main():
    images = []
    for size in (16, 32, 48):
        images.append((size, png(size, render(size))))
        print(f"  rendered {size}x{size}")

    (ROOT / "favicon.ico").write_bytes(ico(images))
    print(f"  favicon.ico          {(ROOT / 'favicon.ico').stat().st_size} bytes")

    touch = png(180, render(180))
    (ROOT / "apple-touch-icon.png").write_bytes(touch)
    print(f"  apple-touch-icon.png {len(touch)} bytes")


if __name__ == "__main__":
    main()
