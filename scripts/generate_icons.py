#!/usr/bin/env python3
from __future__ import annotations

import math
import os
import struct
import zlib
from dataclasses import dataclass


@dataclass(frozen=True)
class Color:
    r: float
    g: float
    b: float

    def mix(self, other: "Color", t: float) -> "Color":
        t = 0.0 if t < 0.0 else 1.0 if t > 1.0 else t
        return Color(
            self.r + (other.r - self.r) * t,
            self.g + (other.g - self.g) * t,
            self.b + (other.b - self.b) * t,
        )


def clamp01(x: float) -> float:
    return 0.0 if x < 0.0 else 1.0 if x > 1.0 else x


def smoothstep(edge0: float, edge1: float, x: float) -> float:
    if edge0 == edge1:
        return 0.0
    t = clamp01((x - edge0) / (edge1 - edge0))
    return t * t * (3.0 - 2.0 * t)


def dist_to_segment(px: float, py: float, ax: float, ay: float, bx: float, by: float) -> float:
    vx = bx - ax
    vy = by - ay
    wx = px - ax
    wy = py - ay
    c1 = vx * wx + vy * wy
    if c1 <= 0.0:
        return math.hypot(wx, wy)
    c2 = vx * vx + vy * vy
    if c2 <= c1:
        return math.hypot(px - bx, py - by)
    t = c1 / c2
    ix = ax + t * vx
    iy = ay + t * vy
    return math.hypot(px - ix, py - iy)


def stroke_alpha(dist: float, half_thickness: float, aa: float) -> float:
    # 1.0 inside, 0.0 outside with antialias band.
    return 1.0 - smoothstep(half_thickness - aa, half_thickness + aa, dist)


def circle_alpha(px: float, py: float, cx: float, cy: float, radius: float, aa: float) -> float:
    return stroke_alpha(math.hypot(px - cx, py - cy), radius, aa)


def prompt_mark_alpha(u: float, v: float, thickness: float, dot_radius: float, aa: float) -> float:
    # All coordinates normalized in [0..1]
    # Chevron ">"
    ax, ay = 0.34, 0.36
    mx, my = 0.49, 0.50
    bx, by = 0.34, 0.64

    half = thickness / 2.0
    d1 = dist_to_segment(u, v, ax, ay, mx, my)
    d2 = dist_to_segment(u, v, bx, by, mx, my)
    chevron = stroke_alpha(min(d1, d2), half, aa)

    # Three dots "..."
    dots = 0.0
    for cx in (0.62, 0.72, 0.82):
        dots = max(dots, circle_alpha(u, v, cx, 0.50, dot_radius, aa))

    return max(chevron, dots)


def write_png_rgba(path: str, width: int, height: int, pixel_fn) -> None:
    raw = bytearray()
    for y in range(height):
        raw.append(0)  # filter type 0
        for x in range(width):
            r, g, b, a = pixel_fn(x, y)
            raw.extend((r, g, b, a))

    compressed = zlib.compress(bytes(raw), level=9)

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    png = bytearray()
    png.extend(b"\x89PNG\r\n\x1a\n")
    png.extend(chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)))
    png.extend(chunk(b"IDAT", compressed))
    png.extend(chunk(b"IEND", b""))

    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(png)


def build_app_icon(path: str, size: int = 1024) -> None:
    # Slightly brighter base so the icon pops in a crowded dock/taskbar.
    bg_a = Color(0x14, 0x1D, 0x2A)  # #141d2a
    bg_b = Color(0x0B, 0x12, 0x1A)  # #0b121a
    accent = Color(0x7A, 0xA2, 0xF7)  # #7aa2f7
    accent_2 = Color(0x2A, 0xC3, 0xDE)  # #2ac3de
    white = Color(255, 255, 255)
    black = Color(0, 0, 0)

    inv = 1.0 / float(size)

    def diamond_alpha(u: float, v: float, cx: float, cy: float, r: float, aa: float) -> float:
        d = abs(u - cx) + abs(v - cy)
        return 1.0 - smoothstep(r - aa, r + aa, d)

    def sparkle_alpha(
        u: float,
        v: float,
        cx: float,
        cy: float,
        size: float,
        thickness: float,
        aa: float,
    ) -> float:
        half = thickness / 2.0
        h = stroke_alpha(dist_to_segment(u, v, cx - size, cy, cx + size, cy), half, aa)
        vert = stroke_alpha(dist_to_segment(u, v, cx, cy - size, cx, cy + size), half, aa)
        diamond = diamond_alpha(u, v, cx, cy, r=size * 0.55, aa=aa) * 0.9
        return max(h, vert, diamond)

    def pixel(x: int, y: int):
        u = (x + 0.5) * inv
        v = (y + 0.5) * inv

        # Background: subtle diagonal gradient + two soft glows.
        t = (u + v) * 0.5
        base = bg_a.mix(bg_b, t)

        def glow(cx: float, cy: float, strength: float, col: Color) -> Color:
            dx = u - cx
            dy = v - cy
            d2 = dx * dx + dy * dy
            # Cheap falloff that stays smooth.
            g = 1.0 / (1.0 + d2 / 0.025)
            return base.mix(col, clamp01(g * strength))

        base = glow(0.24, 0.22, 0.50, accent)
        base = glow(0.78, 0.80, 0.38, accent_2)

        # Gentle vignette.
        dx = u - 0.5
        dy = v - 0.5
        vignette = clamp01((dx * dx + dy * dy) / 0.35)
        base = base.mix(black, vignette * 0.14)

        # Subtle edge highlight to improve recognizability at small sizes.
        edge = min(u, v, 1.0 - u, 1.0 - v)
        edge_glow = 1.0 - smoothstep(0.0, 0.028, edge)
        base = base.mix(accent.mix(accent_2, 0.5), edge_glow * 0.08)

        # Prompt glyph with subtle shadow.
        aa = 1.2 * inv
        shadow = prompt_mark_alpha(u + 0.010, v + 0.012, thickness=0.084, dot_radius=0.033, aa=aa)
        glyph = prompt_mark_alpha(u, v, thickness=0.078, dot_radius=0.031, aa=aa)

        # Small "spark" to hint at AI.
        spark_shadow = sparkle_alpha(
            u + 0.010,
            v + 0.012,
            cx=0.84,
            cy=0.34,
            size=0.050,
            thickness=0.018,
            aa=aa,
        )
        spark = sparkle_alpha(
            u,
            v,
            cx=0.84,
            cy=0.34,
            size=0.048,
            thickness=0.016,
            aa=aa,
        )

        out = base
        if shadow > 0.0:
            out = out.mix(black, clamp01(shadow * 0.28))

        if spark_shadow > 0.0:
            out = out.mix(black, clamp01(spark_shadow * 0.24))

        if glyph > 0.0:
            # Gradient glyph (subtle) from accent to accent_2.
            gt = clamp01((u - 0.30) / 0.55)
            fg = accent.mix(accent_2, gt).mix(white, 0.26)
            out = out.mix(fg, glyph)

        if spark > 0.0:
            spark_col = accent_2.mix(accent, 0.25).mix(white, 0.70)
            out = out.mix(spark_col, spark)

        return (int(out.r + 0.5), int(out.g + 0.5), int(out.b + 0.5), 255)

    write_png_rgba(path, size, size, pixel)


def build_tray_icon(path: str, size: int = 32) -> None:
    accent = Color(0x7A, 0xA2, 0xF7)
    accent_2 = Color(0x2A, 0xC3, 0xDE)
    white = Color(255, 255, 255)
    inv = 1.0 / float(size)

    def diamond_alpha(u: float, v: float, cx: float, cy: float, r: float, aa: float) -> float:
        d = abs(u - cx) + abs(v - cy)
        return 1.0 - smoothstep(r - aa, r + aa, d)

    def sparkle_alpha(
        u: float,
        v: float,
        cx: float,
        cy: float,
        size: float,
        thickness: float,
        aa: float,
    ) -> float:
        half = thickness / 2.0
        h = stroke_alpha(dist_to_segment(u, v, cx - size, cy, cx + size, cy), half, aa)
        vert = stroke_alpha(dist_to_segment(u, v, cx, cy - size, cx, cy + size), half, aa)
        diamond = diamond_alpha(u, v, cx, cy, r=size * 0.55, aa=aa) * 0.9
        return max(h, vert, diamond)

    def pixel(x: int, y: int):
        u = (x + 0.5) * inv
        v = (y + 0.5) * inv
        aa = 1.0 * inv
        glyph = prompt_mark_alpha(u, v, thickness=0.205, dot_radius=0.076, aa=aa)
        spark = sparkle_alpha(u, v, cx=0.88, cy=0.32, size=0.11, thickness=0.045, aa=aa)
        mask = max(glyph, spark)
        if mask <= 0.0:
            return (0, 0, 0, 0)
        gt = clamp01((u - 0.28) / 0.62)
        fg = accent.mix(accent_2, gt).mix(white, 0.28)
        return (int(fg.r + 0.5), int(fg.g + 0.5), int(fg.b + 0.5), int(255 * mask + 0.5))

    write_png_rgba(path, size, size, pixel)


def main() -> None:
    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    app_icon_src = os.path.join(repo_root, "src-tauri", "app-icon.png")
    tray_icon = os.path.join(repo_root, "src-tauri", "icons", "tray.png")

    print("Generating app icon:", os.path.relpath(app_icon_src, repo_root))
    build_app_icon(app_icon_src, size=1024)
    print("Generating tray icon:", os.path.relpath(tray_icon, repo_root))
    build_tray_icon(tray_icon, size=32)
    print("Done.")


if __name__ == "__main__":
    main()
