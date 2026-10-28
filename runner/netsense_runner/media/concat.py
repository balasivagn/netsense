"""ffmpeg composition helpers with one shared stage deadline."""

from __future__ import annotations

from pathlib import Path

from netsense_runner.media.ffmpeg import ToolRunner, run_tool


def encode_frames(
    frames_glob: Path,
    fps: float,
    source: Path,
    start_ms: int,
    end_ms: int,
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
            "0",
            "-i",
            str(frames_glob),
            "-ss",
            f"{start_ms / 1000:.6f}",
            "-i",
            str(source),
            "-t",
            f"{(end_ms - start_ms) / 1000:.6f}",
            "-map",
            "0:v:0",
            "-map",
            "1:a:0?",
            "-c:v",
            "libx264",
            "-crf",
            "23",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-movflags",
            "+faststart",
            str(output),
        ),
        deadline,
    )


def concat_files(parts: list[Path], output: Path, tool: ToolRunner, deadline: float) -> None:
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
            "-c",
            "copy",
            "-movflags",
            "+faststart",
            str(output),
        ),
        deadline,
    )
