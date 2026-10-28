"""Small, scrubbed ffmpeg/ffprobe helpers for the transcode stage."""

from __future__ import annotations

import json
import math
import time
from pathlib import Path
from typing import Mapping, Protocol, cast

from netsense_runner.adapters.tool import ToolExecutionError, ToolResult


class ToolRunner(Protocol):
    def run(self, command: tuple[str, ...], *, timeout_s: float) -> ToolResult: ...


class MediaProbeError(RuntimeError):
    """A probe failed without retaining ffprobe's potentially sensitive output."""

    def __init__(self, error_code: str) -> None:
        super().__init__(error_code)
        self.error_code = error_code


def remaining_timeout(deadline_monotonic: float) -> float:
    """Return the single stage deadline budget left for the next tool invocation."""
    remaining = deadline_monotonic - time.monotonic()
    if not math.isfinite(remaining) or remaining <= 0:
        raise ToolExecutionError("STAGE_TIMEOUT")
    return remaining


def run_tool(tool: ToolRunner, command: tuple[str, ...], deadline_monotonic: float) -> bytes:
    """Run one command without resetting the stage's deadline."""
    result = tool.run(command, timeout_s=remaining_timeout(deadline_monotonic))
    return result.stdout


def probe(path: Path, tool: ToolRunner, deadline_monotonic: float) -> Mapping[str, object]:
    command = (
        "ffprobe",
        "-v",
        "error",
        "-count_frames",
        "-show_entries",
        "format=duration:stream=index,codec_type,codec_name,width,height,avg_frame_rate,"
        "r_frame_rate,nb_read_frames,duration",
        "-of",
        "json",
        str(path),
    )
    try:
        raw = run_tool(tool, command, deadline_monotonic)
        decoded = json.loads(raw)
    except ToolExecutionError as error:
        raise MediaProbeError(error.error_code) from None
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise MediaProbeError("MEDIA_PROBE_FAILED") from None
    if not isinstance(decoded, dict):
        raise MediaProbeError("MEDIA_PROBE_FAILED")
    return cast(Mapping[str, object], decoded)


def stream(probe_data: Mapping[str, object], kind: str) -> Mapping[str, object] | None:
    streams = probe_data.get("streams")
    if not isinstance(streams, list):
        return None
    for item in streams:
        if isinstance(item, dict) and item.get("codec_type") == kind:
            return cast(Mapping[str, object], item)
    return None


def positive_float(value: object) -> float | None:
    try:
        parsed = float(cast(str | int | float, value))
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) and parsed > 0 else None


def frame_rate(value: object) -> float | None:
    if not isinstance(value, str) or "/" not in value:
        return positive_float(value)
    numerator, denominator = value.split("/", 1)
    top = positive_float(numerator)
    bottom = positive_float(denominator)
    if top is None or bottom is None:
        return None
    rate = top / bottom
    return rate if math.isfinite(rate) and rate > 0 else None


def transcode_proxy(
    source: Path, target: Path, tool: ToolRunner, deadline_monotonic: float
) -> None:
    run_tool(
        tool,
        (
            "ffmpeg",
            "-y",
            "-v",
            "error",
            "-i",
            str(source),
            "-vf",
            "scale=-2:720",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "23",
            "-c:a",
            "aac",
            "-b:a",
            "96k",
            "-movflags",
            "+faststart",
            str(target),
        ),
        deadline_monotonic,
    )


def extract_m4a(proxy: Path, target: Path, tool: ToolRunner, deadline_monotonic: float) -> None:
    run_tool(
        tool,
        (
            "ffmpeg",
            "-y",
            "-v",
            "error",
            "-i",
            str(proxy),
            "-map",
            "0:a:0",
            "-c:a",
            "aac",
            "-b:a",
            "96k",
            str(target),
        ),
        deadline_monotonic,
    )


def extract_wav(
    proxy: Path,
    target: Path,
    *,
    start_s: float,
    duration_s: float,
    tool: ToolRunner,
    deadline_monotonic: float,
) -> None:
    run_tool(
        tool,
        (
            "ffmpeg",
            "-y",
            "-v",
            "error",
            "-ss",
            f"{start_s:.6f}",
            "-i",
            str(proxy),
            "-t",
            f"{duration_s:.6f}",
            "-map",
            "0:a:0",
            "-map_metadata",
            "-1",
            "-ac",
            "1",
            "-ar",
            "24000",
            "-c:a",
            "pcm_s16le",
            str(target),
        ),
        deadline_monotonic,
    )
