"""Local, contract-isolated Stage 8 renderer.  DAG wiring belongs to L5."""

from __future__ import annotations

import json
import math
import re
import shutil
import tempfile
from bisect import bisect_left, bisect_right
from collections.abc import Iterator, Mapping
from pathlib import Path
from typing import Protocol, cast

from PIL import Image

from netsense_runner.adapters.tool import ToolAdapter, ToolExecutionError
from netsense_runner.context import StageContext
from netsense_runner.contract_validation import validate_contract
from netsense_runner.contracts.RenderInput import Annotation, RenderInput, Segment
from netsense_runner.contracts.TrackFile import TrackFile
from netsense_runner.json_types import JsonValue
from netsense_runner.media.concat import concat_files, concat_video_files, encode_frames
from netsense_runner.media.ffmpeg import (
    MediaProbeError,
    ToolRunner,
    probe,
    remaining_timeout,
    run_tool,
)
from netsense_runner.media.overlay_draw import OverlayMark, draw_marks
from netsense_runner.media.render_validation import media_shape, safe_id, safe_key, validate_track
from netsense_runner.media.segments import SegmentRange, merged_ranges
from netsense_runner.stage import StageKey, StageResult, Usage, WorkerType


class Download(Protocol):
    """Must enforce total bytes and network timeouts, including each iterator next()."""

    def __call__(self, url: str, /, *, timeout_s: float, max_bytes: int) -> Iterator[bytes]: ...


class TrackLoader(Protocol):
    """Must enforce max_bytes during reading, not after allocating the response."""

    def __call__(self, ref: str, /, *, timeout_s: float, max_bytes: int) -> bytes: ...


class ObjectExists(Protocol):
    def __call__(self, key: str, /, *, timeout_s: float) -> bool: ...


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
    return safe_key(key, session_id)


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
        font_path: str | None = None,
    ) -> None:
        self._font_path = font_path
        self._download, self._track_loader, self._tool, self._exists = (
            download,
            track_loader,
            tool or ToolAdapter(),
            object_exists or (lambda _key, **_limits: False),
        )

    def run(self, input_value: Mapping[str, JsonValue], ctx: StageContext) -> StageResult:
        try:
            value = validate_contract("RenderInput", json.dumps(input_value))
            raw = cast(RenderInput, value)
            if not _safe_key(raw.proxyKey, ctx.session_id):
                raise ValueError
            if raw.proxyKey != f"sessions/{ctx.session_id}/proxy.mp4":
                raise ValueError
            annotations = raw.annotations
            if (
                any(not safe_id(item.annotationId) for item in annotations)
                or any(not safe_id(item.segmentId) for item in raw.segments + raw.previousSegments)
                or any(not _safe_key(item.key, ctx.session_id) for item in raw.previousSegments)
            ):
                raise ValueError
            if len({item.annotationId for item in annotations}) != len(annotations):
                raise ValueError
            if any(
                not _safe_key(item.trackFileRef, ctx.session_id)
                or re.fullmatch(r"sessions/[^/]+/tracks/[A-Za-z0-9_-]+\.json", item.trackFileRef)
                is None
                for item in annotations
            ):
                raise ValueError
            if any(
                item.key
                not in {
                    f"sessions/{ctx.session_id}/renders/preview/{item.segmentId}-{item.hash}.mp4",
                    f"sessions/{ctx.session_id}/renders/final/{item.segmentId}-{item.hash}.mp4",
                }
                for item in raw.previousSegments
            ):
                raise ValueError
            ranges = merged_ranges([a.model_dump() for a in annotations], raw.durationMs)
            self._validate_segments(raw.segments, ranges)
        except (TypeError, ValueError):
            return _failure("CONTRACT_INVALID")
        work = Path(tempfile.mkdtemp(prefix="netsense-render-"))
        try:
            source = work / "proxy.mp4"
            remaining_timeout(ctx.deadline_monotonic)
            url = ctx.storage.get_url(raw.proxyKey)
            remaining_timeout(ctx.deadline_monotonic)
            self._download_to(url, source, ctx.deadline_monotonic)
            data = probe(source, self._tool, ctx.deadline_monotonic)
            width, height, fps = media_shape(data, raw.durationMs)
            track_map = self._tracks(annotations, ctx.session_id, ctx.deadline_monotonic)
            for track in track_map.values():
                validate_track(track, width, height, raw.durationMs)
            try:
                self._validate_cfr(source, fps, ctx)
            except ValueError:
                # Explicit normalization on the original time axis, verified afterwards.
                normalized = work / "normalized.mp4"
                run_tool(
                    self._tool,
                    (
                        "ffmpeg",
                        "-y",
                        "-v",
                        "error",
                        "-i",
                        str(source),
                        "-vf",
                        "fps=30:start_time=0",
                        "-c:v",
                        "libx264",
                        "-crf",
                        "23",
                        "-pix_fmt",
                        "yuv420p",
                        "-c:a",
                        "copy",
                        "-t",
                        f"{raw.durationMs / 1000:.9f}",
                        "-video_track_timescale",
                        "90000",
                        "-movflags",
                        "+faststart",
                        str(normalized),
                    ),
                    ctx.deadline_monotonic,
                )
                source = normalized
                width, height, fps = media_shape(
                    probe(source, self._tool, ctx.deadline_monotonic), raw.durationMs
                )
                self._validate_cfr(source, fps, ctx)
                self._check_disk(work, ctx)
            remaining_timeout(ctx.deadline_monotonic)
            still_refs = self._stills(source, work, annotations, track_map, ctx)
            segment_refs: list[dict[str, JsonValue]] = []
            output: dict[str, JsonValue]
            if raw.mode == "stills":
                output = {
                    "kind": raw.kind,
                    "mode": raw.mode,
                    "fileRef": None,
                    "stillRefs": cast(list[JsonValue], still_refs),
                    "segmentRefs": [],
                    "durationMs": raw.durationMs,
                }
            else:
                parts = self._render_video(
                    source, work, annotations, track_map, fps, ranges, raw, ctx, segment_refs
                )
                final = work / "render.mp4"
                concat_files(
                    parts, final, self._tool, ctx.deadline_monotonic, source, raw.durationMs
                )
                final_key = f"sessions/{ctx.session_id}/renders/{raw.kind}/full.mp4"
                self._put(ctx, final_key, final, "video/mp4")
                output = {
                    "kind": raw.kind,
                    "mode": raw.mode,
                    "fileRef": final_key,
                    "stillRefs": cast(list[JsonValue], still_refs),
                    "segmentRefs": cast(list[JsonValue], segment_refs),
                    "durationMs": raw.durationMs,
                }
            remaining_timeout(ctx.deadline_monotonic)
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
        except MediaProbeError as error:
            return _failure(
                "STAGE_TIMEOUT" if error.error_code == "STAGE_TIMEOUT" else "RENDER_FAIL"
            )
        except Exception:
            # Injected storage/loaders may raise arbitrary errors. Never expose their messages.
            return _failure("RENDER_FAIL")
        finally:
            shutil.rmtree(work, ignore_errors=True)

    def _validate_segments(self, supplied: list[Segment], ranges: list[SegmentRange]) -> None:
        if len(supplied) != len(ranges) or len({item.segmentId for item in supplied}) != len(
            supplied
        ):
            raise ValueError
        for item, expected in zip(
            sorted(supplied, key=lambda s: (s.startMs, s.endMs)), ranges, strict=True
        ):
            if (
                item.startMs,
                item.endMs,
                tuple(sorted(item.annotationIds)),
                item.hash,
            ) != (
                expected.start_ms,
                expected.end_ms,
                tuple(sorted(expected.annotation_ids)),
                expected.digest,
            ):
                raise ValueError

    def _download_to(self, url: str, target: Path, deadline: float) -> None:
        remaining_timeout(deadline)
        chunks = iter(
            self._download(url, timeout_s=remaining_timeout(deadline), max_bytes=2 * 1024**3)
        )
        try:
            with target.open("wb") as handle:
                total = 0
                while True:
                    remaining_timeout(deadline)
                    try:
                        chunk = next(chunks)
                    except StopIteration:
                        remaining_timeout(deadline)
                        break
                    remaining_timeout(deadline)
                    if not isinstance(chunk, bytes) or len(chunk) > 1024 * 1024:
                        raise ValueError
                    total += len(chunk)
                    if total > 2 * 1024 * 1024 * 1024:
                        raise ValueError
                    handle.write(chunk)
        finally:
            close = getattr(chunks, "close", None)
            if callable(close):
                close()

    def _tracks(
        self, annotations: list[Annotation], session_id: str, deadline: float
    ) -> dict[str, TrackFile]:
        result: dict[str, TrackFile] = {}
        for ref in {item.trackFileRef for item in annotations}:
            if not _safe_key(ref, session_id):
                raise ValueError
            remaining_timeout(deadline)
            content = self._track_loader(
                ref, timeout_s=remaining_timeout(deadline), max_bytes=1024**2
            )
            remaining_timeout(deadline)
            if len(content) > 1024 * 1024:
                raise ValueError
            result[ref] = cast(TrackFile, validate_contract("TrackFile", content.decode()))
        return result

    def _box_at(self, track: TrackFile, ms: float) -> tuple[float, float, float, float] | None:
        # Never interpolate or cross a missing/unsafe observation. With no verified
        # re-entry in TrackFile, all observations after the first swap stay suppressed.
        if track.swaps and track.swaps[0].ms <= ms:
            return None
        index = bisect_left(track.frames, ms, key=lambda frame: frame.ms)
        candidates = track.frames[max(0, index - 1) : index + 1]
        valid = []
        for frame in candidates:
            if track.fps == 0 and frame.ms != ms:
                continue
            if track.fps > 0 and abs(frame.ms - ms) > 500 / track.fps:
                continue
            left, right = min(frame.ms, ms), max(frame.ms, ms)
            if track.swaps and track.swaps[0].ms <= right:
                continue
            gap_index = bisect_right(track.gaps, left, key=lambda gap: gap.root[0].root)
            nearby = track.gaps[max(0, gap_index - 1) : gap_index + 1]
            if any(gap.root[0].root <= right and gap.root[1].root > left for gap in nearby):
                continue
            valid.append(frame)
        if not valid:
            return None
        frame = min(valid, key=lambda candidate: (abs(candidate.ms - ms), candidate.ms))
        return (frame.box.x1, frame.box.y1, frame.box.x2, frame.box.y2)

    def _stills(
        self,
        source: Path,
        work: Path,
        annotations: list[Annotation],
        tracks: dict[str, TrackFile],
        ctx: StageContext,
    ) -> list[dict[str, JsonValue]]:
        refs: list[dict[str, JsonValue]] = []
        for annotation in annotations:
            remaining_timeout(ctx.deadline_monotonic)
            track = tracks[annotation.trackFileRef]
            frame_ms: int | None = None
            for frame in track.frames:
                remaining_timeout(ctx.deadline_monotonic)
                if (
                    annotation.startMs <= frame.ms < annotation.endMs
                    and self._box_at(track, frame.ms) is not None
                ):
                    frame_ms = frame.ms
                    break
            if frame_ms is None:
                raise ValueError
            # Video tracks lack selected keyframeMs in RenderInput. This is explicitly
            # the first valid observation, not a proven separate upstream selection.
            box = self._box_at(track, frame_ms)
            assert box is not None
            image = work / f"still-{len(refs)}.jpg"
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
                            annotation.markType,
                            annotation.anchor,
                            annotation.arrowFrom,
                            annotation.labelText,
                            annotation.placedBy,
                        )
                    ],
                    font_path=self._font_path,
                ).convert("RGB").save(image, quality=90)
            key = f"sessions/{ctx.session_id}/stills/{annotation.annotationId}.jpg"
            self._put(ctx, key, image, "image/jpeg")
            refs.append({"annotationId": annotation.annotationId, "key": key})
        return refs

    def _render_video(
        self,
        source: Path,
        work: Path,
        annotations: list[Annotation],
        tracks: dict[str, TrackFile],
        fps: float,
        ranges: list[SegmentRange],
        raw: RenderInput,
        ctx: StageContext,
        refs: list[dict[str, JsonValue]],
    ) -> list[Path]:
        parts: list[Path] = []
        cursor = 0
        supplied = {item.hash: item for item in raw.segments}
        previous = {
            (item.segmentId, item.hash): item.key
            for item in raw.previousSegments
            if _safe_key(item.key, ctx.session_id)
        }
        for index, segment in enumerate(ranges):
            if math.ceil(cursor * fps / 1000 - 1e-7) < math.ceil(
                segment.start_ms * fps / 1000 - 1e-7
            ):
                parts.append(
                    self._plain(source, work / f"plain-{index}.mp4", cursor, segment.start_ms, ctx)
                )
            provided = supplied[segment.digest]
            key = (
                f"sessions/{ctx.session_id}/renders/{raw.kind}/"
                f"{provided.segmentId}-{segment.digest}.mp4"
            )
            cached = previous.get((provided.segmentId, segment.digest))
            local = work / f"segment-{index}.mp4"
            remaining_timeout(ctx.deadline_monotonic)
            reusable = False
            if cached and self._exists(cached, timeout_s=remaining_timeout(ctx.deadline_monotonic)):
                remaining_timeout(ctx.deadline_monotonic)
                try:
                    self._download_to(ctx.storage.get_url(cached), local, ctx.deadline_monotonic)
                    cached_data = json.loads(
                        run_tool(
                            self._tool,
                            (
                                "ffprobe",
                                "-v",
                                "error",
                                "-count_frames",
                                "-show_streams",
                                "-show_format",
                                "-of",
                                "json",
                                str(local),
                            ),
                            ctx.deadline_monotonic,
                        )
                    )
                    from netsense_runner.media.ffmpeg import stream

                    cached_video = stream(cached_data, "video")
                    source_video = stream(
                        probe(source, self._tool, ctx.deadline_monotonic), "video"
                    )
                    expected_ms = round(
                        (
                            math.ceil(segment.end_ms * fps / 1000 - 1e-7)
                            - math.ceil(segment.start_ms * fps / 1000 - 1e-7)
                        )
                        * 1000
                        / fps
                    )
                    media_shape(cached_data, expected_ms)
                    fmt = cast(dict[str, object], cached_data["format"])
                    expected_frames = math.ceil(segment.end_ms * fps / 1000 - 1e-7) - math.ceil(
                        segment.start_ms * fps / 1000 - 1e-7
                    )
                    reusable = (
                        abs(float(str(fmt["duration"])) - expected_frames / fps) <= 0.002
                        and cached_video is not None
                        and int(str(cached_video.get("nb_read_frames", 0))) == expected_frames
                        and cached_video.get("time_base") == "1/90000"
                        and cached_video.get("pix_fmt") == "yuv420p"
                        and source_video is not None
                        and all(
                            cached_video.get(field) == source_video.get(field)
                            for field in ("width", "height", "codec_name", "avg_frame_rate")
                        )
                        and cached_video.get("codec_name") == "h264"
                    )
                    if reusable:
                        self._validate_cfr(local, fps, ctx)
                        key = cached
                except (MediaProbeError, ToolExecutionError) as error:
                    if error.error_code == "STAGE_TIMEOUT":
                        raise
                except (OSError, ValueError, KeyError):
                    pass
            if not reusable:
                clip = self._annotated(source, work, annotations, tracks, fps, segment, ctx)
                self._put(ctx, key, clip, "video/mp4")
                clip.replace(local)
            self._check_disk(work, ctx)
            parts.append(local)
            refs.append({"segmentId": provided.segmentId, "hash": segment.digest, "key": key})
            cursor = segment.end_ms
        if math.ceil(cursor * fps / 1000 - 1e-7) < math.ceil(raw.durationMs * fps / 1000 - 1e-7):
            parts.append(self._plain(source, work / "plain-final.mp4", cursor, raw.durationMs, ctx))
        return parts

    def _put(self, ctx: StageContext, key: str, path: Path, content_type: str) -> None:
        remaining_timeout(ctx.deadline_monotonic)
        ctx.storage.put_file(key, str(path), content_type)
        remaining_timeout(ctx.deadline_monotonic)

    def _plain(self, source: Path, output: Path, start: int, end: int, ctx: StageContext) -> Path:
        from netsense_runner.media.ffmpeg import frame_rate, stream

        video = stream(probe(source, self._tool, ctx.deadline_monotonic), "video")
        fps = frame_rate(video.get("avg_frame_rate")) if video else None
        if fps is None:
            raise ValueError
        start_s = math.ceil(start * fps / 1000 - 1e-7) / fps
        end_s = math.ceil(end * fps / 1000 - 1e-7) / fps
        run_tool(
            self._tool,
            (
                "ffmpeg",
                "-y",
                "-v",
                "error",
                "-ss",
                f"{start_s:.9f}",
                "-i",
                str(source),
                "-frames:v",
                str(round((end_s - start_s) * fps)),
                "-c:v",
                "libx264",
                "-crf",
                "23",
                "-an",
                "-pix_fmt",
                "yuv420p",
                "-video_track_timescale",
                "90000",
                "-movflags",
                "+faststart",
                str(output),
            ),
            ctx.deadline_monotonic,
        )
        return output

    def _validate_cfr(self, source: Path, fps: float, ctx: StageContext) -> None:
        # Inspect actual presentation timestamps; avg_frame_rate alone cannot prove CFR.
        content = run_tool(
            self._tool,
            (
                "ffprobe",
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "frame=best_effort_timestamp_time",
                "-of",
                "csv=p=0",
                str(source),
            ),
            ctx.deadline_monotonic,
        )
        times = [float(line.split(b",")[0]) for line in content.splitlines() if line.strip(b", ")]
        if (
            not times
            or len(times) > 108001
            or any(not math.isfinite(t) or abs(t - i / fps) > 0.001 for i, t in enumerate(times))
        ):
            raise ValueError
        remaining_timeout(ctx.deadline_monotonic)

    def _annotated(
        self,
        source: Path,
        work: Path,
        annotations: list[Annotation],
        tracks: dict[str, TrackFile],
        fps: float,
        segment: SegmentRange,
        ctx: StageContext,
    ) -> Path:
        remaining_timeout(ctx.deadline_monotonic)
        data = probe(source, self._tool, ctx.deadline_monotonic)
        shape = media_shape(
            data, round(float(str(cast(dict[str, object], data["format"])["duration"])) * 1000)
        )
        # Bound decoded expansion per batch even for a 30-minute annotated range.
        batch_size = max(1, min(30, 256 * 1024 * 1024 // (shape[0] * shape[1] * 8)))
        first = math.ceil(segment.start_ms * fps / 1000 - 1e-7)
        last = math.ceil(segment.end_ms * fps / 1000 - 1e-7)
        batches: list[Path] = []
        for start in range(first, last, batch_size):
            remaining_timeout(ctx.deadline_monotonic)
            count = min(batch_size, last - start)
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
                    f"{start / fps:.9f}",
                    "-i",
                    str(source),
                    "-vf",
                    f"scale={shape[0]}:{shape[1]}",
                    "-frames:v",
                    str(count),
                    "-vsync",
                    "0",
                    str(pattern),
                ),
                ctx.deadline_monotonic,
            )
            files = sorted(frames.glob("frame-*.png"))
            if len(files) != count:
                raise ValueError
            for idx, file in enumerate(files):
                remaining_timeout(ctx.deadline_monotonic)
                # Fractional presentation times preserve half-open mark predicates.
                ms = (start + idx) * 1000 / fps
                active = [
                    item
                    for item in annotations
                    if item.startMs <= ms < item.endMs
                    and item.annotationId in segment.annotation_ids
                ]
                with Image.open(file) as decoded:
                    image: Image.Image = decoded
                    for item in active:
                        remaining_timeout(ctx.deadline_monotonic)
                        box = self._box_at(tracks[item.trackFileRef], ms)
                        if box is None:
                            continue
                        image = draw_marks(
                            image,
                            box,
                            [
                                OverlayMark(
                                    item.markType,
                                    item.anchor,
                                    item.arrowFrom,
                                    item.labelText,
                                    item.placedBy,
                                )
                            ],
                            font_path=self._font_path,
                        )
                    image.convert("RGB").save(file)
            remaining_timeout(ctx.deadline_monotonic)
            output = work / f"batch-{segment.start_ms}-{start}.mp4"
            encode_frames(
                pattern,
                fps,
                count,
                output,
                self._tool,
                ctx.deadline_monotonic,
            )
            shutil.rmtree(frames)
            batches.append(output)
            self._check_disk(work, ctx)
        output = work / f"annotated-{segment.start_ms}.mp4"
        concat_video_files(batches, output, self._tool, ctx.deadline_monotonic)
        for batch in batches:
            batch.unlink()
        self._check_disk(work, ctx)
        return output

    def _check_disk(self, work: Path, ctx: StageContext) -> None:
        remaining_timeout(ctx.deadline_monotonic)
        if sum(file.stat().st_size for file in work.rglob("*") if file.is_file()) > 4 * 1024**3:
            raise ValueError
