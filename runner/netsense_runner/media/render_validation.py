"""Renderer-only trust boundaries; no storage or media side effects."""

from __future__ import annotations

import math
import re
from collections.abc import Mapping

from netsense_runner.contracts.TrackFile import TrackFile
from netsense_runner.media.ffmpeg import frame_rate, positive_float, stream


def safe_id(value: str) -> bool:
    return re.fullmatch(r"[A-Za-z0-9_-]{1,128}", value) is not None


def safe_key(key: str, session_id: str) -> bool:
    return (
        safe_id(session_id)
        and key.startswith(f"sessions/{session_id}/")
        and all(
            re.fullmatch(r"[A-Za-z0-9_-][A-Za-z0-9_.-]{0,255}", part) is not None
            and part not in {".", ".."}
            for part in key.split("/")
        )
    )


def validate_track(track: TrackFile, width: int, height: int, duration: int) -> None:
    if not math.isfinite(track.fps) or track.fps > 120 or not track.frames:
        raise ValueError
    if track.fps == 0 and len(track.frames) != 1:
        # A still track has one selected keyframe. More needs an explicit selection contract.
        raise ValueError
    last = -1
    for frame in track.frames:
        box = frame.box
        if (
            not last < frame.ms < duration
            or not all(math.isfinite(v) for v in (box.x1, box.y1, box.x2, box.y2, frame.conf))
            or not (0 <= box.x1 < box.x2 <= width and 0 <= box.y1 < box.y2 <= height)
        ):
            raise ValueError
        last = frame.ms
    last = -1
    for gap in track.gaps:
        start, end = (item.root for item in gap.root)
        if not 0 <= start < end <= duration or start < last:
            raise ValueError
        last = end
    last = -1
    for swap in track.swaps:
        if not last < swap.ms < duration:
            raise ValueError
        last = swap.ms


def media_shape(data: Mapping[str, object], duration_ms: int) -> tuple[int, int, float]:
    video = stream(data, "video")
    if video is None:
        raise ValueError
    width, height = video.get("width"), video.get("height")
    fps = frame_rate(video.get("avg_frame_rate"))
    fmt = data.get("format")
    duration = positive_float(fmt.get("duration")) if isinstance(fmt, dict) else None
    if (
        not isinstance(width, int)
        or not isinstance(height, int)
        or not 2 <= width <= 1920
        or not 2 <= height <= 1080
        or width % 2
        or height % 2
        or fps is None
        or not 1 <= fps <= 60
        or duration is None
        or not 0 < duration_ms <= 1800000
        or abs(duration * 1000 - duration_ms) > max(50, 1000 / fps)
    ):
        raise ValueError
    return width, height, fps
