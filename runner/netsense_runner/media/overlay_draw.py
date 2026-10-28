"""Deterministic, shared Pillow geometry for rendered and live overlays.

Coordinates are proxy-image pixels.  Boxes use x1/y1 inclusive, x2/y2 exclusive;
all derived coordinates are rounded half-up.  Keep this module and the synthetic
geometry fixture in sync with the browser implementation.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal

from PIL import Image, ImageDraw, ImageFont


@dataclass(frozen=True, slots=True)
class OverlayMark:
    mark_type: str
    anchor: str
    arrow_from: str | None
    label: str
    placed_by: str


def _round(value: float) -> int:
    return int(Decimal(str(value)).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def anchor_point(box: tuple[float, float, float, float], anchor: str) -> tuple[int, int]:
    x1, y1, x2, y2 = box
    points = {
        "box_center": ((x1 + x2) / 2, (y1 + y2) / 2),
        "box_top": ((x1 + x2) / 2, y1),
        "box_bottom": ((x1 + x2) / 2, y2),
        "box_left": (x1, (y1 + y2) / 2),
        "box_right": (x2, (y1 + y2) / 2),
    }
    return (_round(points[anchor][0]), _round(points[anchor][1]))


def _dashed_line(
    draw: ImageDraw.ImageDraw, start: tuple[int, int], end: tuple[int, int], fill: str, width: int
) -> None:
    dx, dy = end[0] - start[0], end[1] - start[1]
    length = max((dx * dx + dy * dy) ** 0.5, 1.0)
    cursor = 0.0
    while cursor < length:
        nxt = min(cursor + 8.0, length)
        draw.line(
            (
                start[0] + dx * cursor / length,
                start[1] + dy * cursor / length,
                start[0] + dx * nxt / length,
                start[1] + dy * nxt / length,
            ),
            fill=fill,
            width=width,
        )
        cursor += 14.0


def draw_marks(
    image: Image.Image, box: tuple[float, float, float, float], marks: list[OverlayMark]
) -> Image.Image:
    """Draw marks onto one decoded frame; callers never retain full-video buffers."""
    output = image.convert("RGBA")
    draw = ImageDraw.Draw(output, "RGBA")
    x1, y1, x2, y2 = map(_round, box)
    colour = "#4D672A"
    font = ImageFont.load_default()
    for mark in marks:
        dashed = mark.placed_by == "ai"
        target = anchor_point(box, mark.anchor)
        if mark.mark_type == "highlight":
            draw.rectangle((x1, y1, x2, y2), fill=(77, 103, 42, 64), outline=colour, width=3)
        elif mark.mark_type == "circle":
            radius = max(12, _round(min(max(x2 - x1, 1), max(y2 - y1, 1)) * 0.18))
            bounds = (
                target[0] - radius,
                target[1] - radius,
                target[0] + radius,
                target[1] + radius,
            )
            if dashed:
                # Pillow has no portable dashed ellipse: deterministic short arcs.
                for start in range(0, 360, 36):
                    draw.arc(bounds, start, start + 20, fill=colour, width=3)
            else:
                draw.ellipse(bounds, outline=colour, width=3)
        elif mark.mark_type == "arrow":
            side = mark.arrow_from or "left"
            origins = {
                "left": (x1 - 36, target[1]),
                "right": (x2 + 36, target[1]),
                "above": (target[0], y1 - 36),
                "below": (target[0], y2 + 36),
            }
            origin = origins[side]
            if dashed:
                _dashed_line(draw, origin, target, colour, 3)
            else:
                draw.line((*origin, *target), fill=colour, width=3)
            draw.polygon(
                (target, (target[0] - 8, target[1] - 5), (target[0] - 8, target[1] + 5)),
                fill=colour,
            )
        elif mark.mark_type == "label":
            text_box = draw.textbbox((0, 0), mark.label, font=font)
            plate = (
                x1,
                max(0, y1 - (text_box[3] - text_box[1]) - 10),
                x1 + (text_box[2] - text_box[0]) + 10,
                max(0, y1 - 2),
            )
            draw.rectangle(plate, fill=(77, 103, 42, 230))
            draw.text((plate[0] + 5, plate[1] + 4), mark.label, fill="white", font=font)
    return output
