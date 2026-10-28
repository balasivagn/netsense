"""Keyframe extraction and index construction for the transcode stage."""

from __future__ import annotations

from pathlib import Path

from netsense_runner.media.ffmpeg import ToolRunner, run_tool


def extract_keyframes(
    proxy: Path, output_dir: Path, tool: ToolRunner, deadline_monotonic: float
) -> list[Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    run_tool(
        tool,
        (
            "ffmpeg",
            "-y",
            "-v",
            "error",
            "-i",
            str(proxy),
            "-vf",
            "fps=2,scale=640:-2",
            "-q:v",
            "3",
            str(output_dir / "frame-%06d.jpg"),
        ),
        deadline_monotonic,
    )
    return sorted(output_dir.glob("frame-*.jpg"))
