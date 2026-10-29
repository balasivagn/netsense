"""Deterministic, shared Pillow geometry for rendered and live overlays.

Coordinates are proxy-image pixels.  Boxes use x1/y1 inclusive, x2/y2 exclusive;
all derived coordinates are rounded half-up.  Keep this module and the synthetic
geometry fixture in sync with the browser implementation.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal
from importlib.resources import files

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
    image: Image.Image,
    box: tuple[float, float, float, float],
    marks: list[OverlayMark],
    *,
    font_path: str | None = None,
) -> Image.Image:
    """Draw marks onto one decoded frame; callers never retain full-video buffers."""
    background = image.convert("RGBA")
    output = Image.new("RGBA", image.size)
    draw = ImageDraw.Draw(output)
    x1, y1, x2, y2 = map(_round, box)
    colour = "#4D672A"
    # Ship a reproducible Unicode-capable font rather than Pillow's ASCII-only default.
    default_font = files("font_roboto").joinpath("files/Roboto-Regular.ttf")
    font = ImageFont.truetype(font_path or str(default_font), size=14)
    for mark in marks:
        dashed = mark.placed_by == "ai"
        target = anchor_point(box, mark.anchor)
        if mark.mark_type == "highlight":
            bounds = (x1, y1, x2 - 1, y2 - 1)
            draw.rectangle(bounds, fill=(77, 103, 42, 64))
            if dashed:
                corners = [(x1, y1), (x2 - 1, y1), (x2 - 1, y2 - 1), (x1, y2 - 1)]
                for edge_start, edge_end in zip(corners, corners[1:] + corners[:1], strict=True):
                    _dashed_line(draw, edge_start, edge_end, colour, 3)
            else:
                draw.rectangle(bounds, outline=colour, width=3)
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
            draw.polygon(arrow_geometry(box, mark.anchor, side)[1], fill=colour)
        elif mark.mark_type == "label":
            # Never silently replace unsupported coach characters with a missing-glyph box.
            missing = bytes(font.getmask(chr(0x10FFFF)))
            if len(mark.label) > 60 or any(
                not char.isspace() and bytes(font.getmask(char)) == missing for char in mark.label
            ):
                raise ValueError("RENDER_FONT_UNSUPPORTED")
            label_font = font
            for size in range(14, 0, -1):
                label_font = font.font_variant(size=size)
                text_box = draw.textbbox((0, 0), mark.label, font=label_font)
                width = _round(text_box[2] - text_box[0]) + 10
                height = _round(text_box[3] - text_box[1]) + 10
                if width < image.width and height < image.height:
                    break
            else:
                raise ValueError("RENDER_LABEL_DOES_NOT_FIT")
            left = max(0, min(x1, image.width - width))
            top = max(0, min(y1 - height - 2, image.height - height))
            plate = (left, top, left + width, top + height)
            draw.rectangle(plate, fill=(77, 103, 42, 230))
            if dashed:
                corners = [
                    (left, top),
                    (left + width, top),
                    (left + width, top + height),
                    (left, top + height),
                ]
                for edge_start, edge_end in zip(corners, corners[1:] + corners[:1], strict=True):
                    _dashed_line(draw, edge_start, edge_end, "white", 2)
            else:
                draw.rectangle(plate, outline="white", width=2)
            draw.text(
                (left + 5 - text_box[0], top + 5 - text_box[1]),
                mark.label, fill="white", font=label_font
            )
    return Image.alpha_composite(background, output)


def arrow_geometry(
    box: tuple[float, float, float, float], anchor: str, side: str
) -> tuple[tuple[int, int], tuple[tuple[int, int], ...]]:
    """Shared numeric arrow geometry; triangle points from origin toward target."""
    x1, y1, x2, y2 = map(_round, box)
    target = anchor_point(box, anchor)
    origin = {
        "left": (x1 - 36, target[1]),
        "right": (x2 + 36, target[1]),
        "above": (target[0], y1 - 36),
        "below": (target[0], y2 + 36),
    }[side]
    dx, dy = target[0] - origin[0], target[1] - origin[1]
    length = math.hypot(dx, dy)
    ux, uy = dx / length, dy / length
    head = (
        target,
        (_round(target[0] - 8 * ux - 5 * uy), _round(target[1] - 8 * uy + 5 * ux)),
        (_round(target[0] - 8 * ux + 5 * uy), _round(target[1] - 8 * uy - 5 * ux)),
    )
    return origin, head
