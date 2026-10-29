"""ffmpeg composition helpers with one shared stage deadline."""

from __future__ import annotations

from pathlib import Path

from netsense_runner.media.ffmpeg import ToolRunner, run_tool


def encode_frames(
    frames_glob: Path,
    fps: float,
    frame_count: int,
    output: Path,
    tool: ToolRunner,
    deadline: float,
) -> None:
    run_tool(
        tool,
        (
            "ffmpeg",
            "-y",
            "-v",
            "error",
            "-framerate",
            f"{fps:.8f}",
            "-start_number",
            "1",
            "-i",
            str(frames_glob),
            "-frames:v",
            str(frame_count),
            "-map",
            "0:v:0",
            "-an",
            "-c:v",
            "libx264",
            "-crf",
            "23",
            "-pix_fmt",
            "yuv420p",
            "-video_track_timescale",
            "90000",
            "-movflags",
            "+faststart",
            str(output),
        ),
        deadline,
    )


def concat_files(
    parts: list[Path],
    output: Path,
    tool: ToolRunner,
    deadline: float,
    source: Path,
    duration_ms: int,
) -> None:
    listing = output.with_suffix(".txt")
    listing.write_text("".join(f"file '{part.as_posix()}'\n" for part in parts), encoding="utf-8")
    run_tool(
        tool,
        (
            "ffmpeg",
            "-y",
            "-v",
            "error",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(listing),
            "-i",
            str(source),
            "-map",
            "0:v:0",
            "-map",
            "1:a:0?",
            "-c",
            "copy",
            "-t",
            f"{duration_ms / 1000:.6f}",
            "-video_track_timescale",
            "90000",
            "-movflags",
            "+faststart",
            str(output),
        ),
        deadline,
    )


def concat_video_files(parts: list[Path], output: Path, tool: ToolRunner, deadline: float) -> None:
    """Join bounded rendered batches without introducing audio or extra frames."""
    listing = output.with_suffix(".txt")
    listing.write_text("".join(f"file '{part.as_posix()}'\n" for part in parts), encoding="utf-8")
    run_tool(
        tool,
        (
            "ffmpeg",
            "-y",
            "-v",
            "error",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(listing),
            "-an",
            "-c:v",
            "copy",
            "-video_track_timescale",
            "90000",
            "-movflags",
            "+faststart",
            str(output),
        ),
        deadline,
    )
