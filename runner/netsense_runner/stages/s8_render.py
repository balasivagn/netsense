"""Local, contract-isolated Stage 8 renderer.  DAG wiring belongs to L5."""

from __future__ import annotations

import json
import shutil
import tempfile
from collections.abc import Callable, Iterator, Mapping
from pathlib import Path
from typing import Any, cast

from PIL import Image

from netsense_runner.adapters.tool import ToolAdapter, ToolExecutionError
from netsense_runner.context import StageContext
from netsense_runner.contract_validation import validate_contract
from netsense_runner.contracts.TrackFile import TrackFile
from netsense_runner.json_types import JsonValue
from netsense_runner.media.concat import concat_files, encode_frames
from netsense_runner.media.ffmpeg import (
    MediaProbeError,
    ToolRunner,
    frame_rate,
    probe,
    remaining_timeout,
    run_tool,
    stream,
)
from netsense_runner.media.overlay_draw import OverlayMark, draw_marks
from netsense_runner.media.segments import SegmentRange, merged_ranges
from netsense_runner.stage import StageKey, StageResult, Usage, WorkerType

Download = Callable[[str], Iterator[bytes]]
TrackLoader = Callable[[str], bytes]
ObjectExists = Callable[[str], bool]


def _usage() -> Usage:
    return {"samFrames": 0, "inputTokens": 0, "outputTokens": 0, "audioSeconds": 0}


def _failure(code: str) -> StageResult:
    return {
        "status": "failed",
        "output": None,
        "error_code": code,
        "usage": _usage(),
        "cost_usd": 0.0,
        "trace": None,
    }


def _safe_key(key: str, session_id: str) -> bool:
    prefix = f"sessions/{session_id}/"
    return (
        key.startswith(prefix)
        and not key.startswith("/")
        and ".." not in key.split("/")
        and "\\" not in key
        and "%" not in key
        and all(part for part in key.split("/"))
    )


class RenderWorker:
    id = "render.ffmpeg@1"
    stage: StageKey = "render"
    worker_type: WorkerType = "tool"
    input_contract = "RenderInput"
    output_contract = "RenderOutput"

    def __init__(
        self,
        *,
        download: Download,
        track_loader: TrackLoader,
        tool: ToolRunner | None = None,
        object_exists: ObjectExists | None = None,
    ) -> None:
        self._download, self._track_loader, self._tool, self._exists = (
            download,
            track_loader,
            tool or ToolAdapter(),
            object_exists or (lambda _key: False),
        )

    def run(self, input_value: Mapping[str, JsonValue], ctx: StageContext) -> StageResult:
        try:
            value = validate_contract("RenderInput", json.dumps(input_value))
            raw = cast(dict[str, Any], cast(Any, value).model_dump(by_alias=True))
            if not _safe_key(raw["proxyKey"], ctx.session_id):
                raise ValueError
            annotations = raw["annotations"]
            if len({item["annotationId"] for item in annotations}) != len(annotations):
                raise ValueError
            if any(not _safe_key(item["trackFileRef"], ctx.session_id) for item in annotations):
                raise ValueError
            ranges = merged_ranges(annotations, raw["durationMs"])
            self._validate_segments(raw["segments"], ranges)
        except (TypeError, ValueError):
            return _failure("CONTRACT_INVALID")
        work = Path(tempfile.mkdtemp(prefix="netsense-render-"))
        try:
            source = work / "proxy.mp4"
            self._download_to(ctx.storage.get_url(raw["proxyKey"]), source, ctx.deadline_monotonic)
            data = probe(source, self._tool, ctx.deadline_monotonic)
            video = stream(data, "video")
            fps = frame_rate(video.get("avg_frame_rate") if video else None)
            if video is None or fps is None:
                return _failure("RENDER_FAIL")
            track_map = self._tracks(annotations, ctx.session_id)
            still_refs = self._stills(source, work, annotations, track_map, fps, raw, ctx)
            segment_refs: list[dict[str, JsonValue]] = []
            if raw["mode"] == "stills":
                output = {
                    "kind": raw["kind"],
                    "mode": raw["mode"],
                    "fileRef": None,
                    "stillRefs": still_refs,
                    "segmentRefs": [],
                    "durationMs": raw["durationMs"],
                }
            else:
                parts = self._render_video(
                    source, work, annotations, track_map, fps, ranges, raw, ctx, segment_refs
                )
                final = work / "render.mp4"
                concat_files(parts, final, self._tool, ctx.deadline_monotonic)
                final_key = f"sessions/{ctx.session_id}/renders/{raw['kind']}.mp4"
                ctx.storage.put_file(final_key, str(final), "video/mp4")
                output = {
                    "kind": raw["kind"],
                    "mode": raw["mode"],
                    "fileRef": final_key,
                    "stillRefs": still_refs,
                    "segmentRefs": segment_refs,
                    "durationMs": raw["durationMs"],
                }
            validate_contract("RenderOutput", json.dumps(output))
            return {
                "status": "done",
                "output": output,
                "error_code": None,
                "usage": _usage(),
                "cost_usd": 0.0,
                "trace": None,
            }
        except ToolExecutionError as error:
            return _failure(
                "STAGE_TIMEOUT" if error.error_code == "STAGE_TIMEOUT" else "RENDER_FAIL"
            )
        except (OSError, ValueError, MediaProbeError, KeyError):
            return _failure("RENDER_FAIL")
        finally:
            shutil.rmtree(work, ignore_errors=True)

    def _validate_segments(
        self, supplied: list[dict[str, Any]], ranges: list[SegmentRange]
    ) -> None:
        if len(supplied) != len(ranges) or len({item["segmentId"] for item in supplied}) != len(
            supplied
        ):
            raise ValueError
        for item, expected in zip(
            sorted(supplied, key=lambda s: (s["startMs"], s["endMs"])), ranges, strict=True
        ):
            if (
                item["startMs"],
                item["endMs"],
                tuple(sorted(item["annotationIds"])),
                item["hash"],
            ) != (
                expected.start_ms,
                expected.end_ms,
                tuple(sorted(expected.annotation_ids)),
                expected.digest,
            ):
                raise ValueError

    def _download_to(self, url: str, target: Path, deadline: float) -> None:
        with target.open("wb") as handle:
            total = 0
            for chunk in self._download(url):
                remaining_timeout(deadline)
                if not isinstance(chunk, bytes) or len(chunk) > 1024 * 1024:
                    raise ValueError
                total += len(chunk)
                if total > 2 * 1024 * 1024 * 1024:
                    raise ValueError
                handle.write(chunk)

    def _tracks(self, annotations: list[dict[str, Any]], session_id: str) -> dict[str, TrackFile]:
        result: dict[str, TrackFile] = {}
        for ref in {item["trackFileRef"] for item in annotations}:
            if not _safe_key(ref, session_id):
                raise ValueError
            result[ref] = cast(
                TrackFile, validate_contract("TrackFile", self._track_loader(ref).decode())
            )
        return result

    def _box_at(self, track: TrackFile, ms: int) -> tuple[float, float, float, float] | None:
        # Never interpolate: a mark exists only at the exact tracked frame and never in gaps/swaps.
        if any(gap.root[0].root <= ms < gap.root[1].root for gap in track.gaps) or any(
            swap.ms == ms for swap in track.swaps
        ):
            return None
        candidates = [frame for frame in track.frames if abs(frame.ms - ms) <= 500 / track.fps]
        if not candidates:
            return None
        frame = min(candidates, key=lambda candidate: (abs(candidate.ms - ms), candidate.ms))
        return (frame.box.x1, frame.box.y1, frame.box.x2, frame.box.y2)

    def _stills(
        self,
        source: Path,
        work: Path,
        annotations: list[dict[str, Any]],
        tracks: dict[str, TrackFile],
        fps: float,
        raw: dict[str, Any],
        ctx: StageContext,
    ) -> list[dict[str, JsonValue]]:
        refs: list[dict[str, JsonValue]] = []
        for annotation in annotations:
            frame_ms = annotation["startMs"]
            box = self._box_at(tracks[annotation["trackFileRef"]], frame_ms)
            if box is None:
                continue
            image = work / f"still-{annotation['annotationId']}.jpg"
            run_tool(
                self._tool,
                (
                    "ffmpeg",
                    "-y",
                    "-v",
                    "error",
                    "-ss",
                    f"{frame_ms / 1000:.6f}",
                    "-i",
                    str(source),
                    "-frames:v",
                    "1",
                    str(image),
                ),
                ctx.deadline_monotonic,
            )
            with Image.open(image) as decoded:
                draw_marks(
                    decoded,
                    box,
                    [
                        OverlayMark(
                            annotation["markType"],
                            annotation["anchor"],
                            annotation["arrowFrom"],
                            annotation["labelText"],
                            annotation["placedBy"],
                        )
                    ],
                ).convert("RGB").save(image, quality=90)
            key = (
                f"sessions/{ctx.session_id}/renders/{raw['kind']}/stills/"
                f"{annotation['annotationId']}.jpg"
            )
            ctx.storage.put_file(key, str(image), "image/jpeg")
            refs.append({"annotationId": annotation["annotationId"], "key": key})
        return refs

    def _render_video(
        self,
        source: Path,
        work: Path,
        annotations: list[dict[str, Any]],
        tracks: dict[str, TrackFile],
        fps: float,
        ranges: list[SegmentRange],
        raw: dict[str, Any],
        ctx: StageContext,
        refs: list[dict[str, JsonValue]],
    ) -> list[Path]:
        parts: list[Path] = []
        cursor = 0
        supplied = {item["hash"]: item for item in raw["segments"]}
        previous = {
            (item["segmentId"], item["hash"]): item["key"]
            for item in raw["previousSegments"]
            if _safe_key(item["key"], ctx.session_id)
        }
        for index, segment in enumerate(ranges):
            if cursor < segment.start_ms:
                parts.append(
                    self._plain(source, work / f"plain-{index}.mp4", cursor, segment.start_ms, ctx)
                )
            provided = supplied[segment.digest]
            key = (
                f"sessions/{ctx.session_id}/renders/{raw['kind']}/segments/"
                f"{provided['segmentId']}-{segment.digest}.mp4"
            )
            cached = previous.get((provided["segmentId"], segment.digest))
            if cached and self._exists(cached):
                key = cached
            else:
                clip = self._annotated(source, work, annotations, tracks, fps, segment, ctx)
                ctx.storage.put_file(key, str(clip), "video/mp4")
            # Concat needs local bytes even for cached objects; its downloader is bounded.
            local = work / f"segment-{index}.mp4"
            self._download_to(ctx.storage.get_url(key), local, ctx.deadline_monotonic)
            parts.append(local)
            refs.append({"segmentId": provided["segmentId"], "hash": segment.digest, "key": key})
            cursor = segment.end_ms
        if cursor < raw["durationMs"]:
            parts.append(
                self._plain(source, work / "plain-final.mp4", cursor, raw["durationMs"], ctx)
            )
        return parts

    def _plain(self, source: Path, output: Path, start: int, end: int, ctx: StageContext) -> Path:
        run_tool(
            self._tool,
            (
                "ffmpeg",
                "-y",
                "-v",
                "error",
                "-ss",
                f"{start / 1000:.6f}",
                "-i",
                str(source),
                "-t",
                f"{(end - start) / 1000:.6f}",
                "-c:v",
                "libx264",
                "-crf",
                "23",
                "-c:a",
                "aac",
                "-movflags",
                "+faststart",
                str(output),
            ),
            ctx.deadline_monotonic,
        )
        return output

    def _annotated(
        self,
        source: Path,
        work: Path,
        annotations: list[dict[str, Any]],
        tracks: dict[str, TrackFile],
        fps: float,
        segment: SegmentRange,
        ctx: StageContext,
    ) -> Path:
        frames = work / f"frames-{segment.start_ms}"
        frames.mkdir()
        pattern = frames / "frame-%06d.png"
        run_tool(
            self._tool,
            (
                "ffmpeg",
                "-y",
                "-v",
                "error",
                "-ss",
                f"{segment.start_ms / 1000:.6f}",
                "-i",
                str(source),
                "-t",
                f"{(segment.end_ms - segment.start_ms) / 1000:.6f}",
                "-vsync",
                "0",
                str(pattern),
            ),
            ctx.deadline_monotonic,
        )
        for idx, file in enumerate(sorted(frames.glob("frame-*.png"))):
            ms = segment.start_ms + round(idx * 1000 / fps)
            active = [
                item
                for item in annotations
                if item["startMs"] <= ms < item["endMs"]
                and item["annotationId"] in segment.annotation_ids
                and self._box_at(tracks[item["trackFileRef"]], ms) is not None
            ]
            with Image.open(file) as decoded:
                image: Image.Image = decoded
                for item in active:
                    box = self._box_at(tracks[item["trackFileRef"]], ms)
                    assert box is not None
                    image = draw_marks(
                        image,
                        box,
                        [
                            OverlayMark(
                                item["markType"],
                                item["anchor"],
                                item["arrowFrom"],
                                item["labelText"],
                                item["placedBy"],
                            )
                        ],
                    )
                image.convert("RGB").save(file)
        output = work / f"annotated-{segment.start_ms}.mp4"
        encode_frames(
            pattern,
            fps,
            source,
            segment.start_ms,
            segment.end_ms,
            output,
            self._tool,
            ctx.deadline_monotonic,
        )
        return output
