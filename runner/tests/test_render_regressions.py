"""Synthetic renderer boundary and real-media regressions from PR16 review."""

from __future__ import annotations

import json
import subprocess
import time
from dataclasses import replace
from pathlib import Path
from typing import Any, cast

import pytest
from PIL import Image, ImageChops
from test_render import Storage, annotation, clip, context, input_value, track, worker

from netsense_runner.adapters.tool import ToolAdapter, ToolExecutionError, ToolResult
from netsense_runner.contracts.RenderInput import Annotation
from netsense_runner.contracts.TrackFile import TrackFile
from netsense_runner.json_types import JsonValue
from netsense_runner.media.overlay_draw import OverlayMark, anchor_point, arrow_geometry, draw_marks
from netsense_runner.media.render_validation import media_shape, validate_track
from netsense_runner.media.segments import build_segments
from netsense_runner.stages.s8_render import RenderWorker, _safe_key


@pytest.mark.parametrize("kind", ["circle", "arrow", "highlight", "label"])
@pytest.mark.parametrize("anchor", ["box_center", "box_top", "box_bottom", "box_left", "box_right"])
def test_all_marks_have_visible_dashed_style(kind: str, anchor: str) -> None:
    image = Image.new("RGB", (240, 240), "white")
    box = (60.0, 60.0, 160.0, 160.0)
    solid = draw_marks(image, box, [OverlayMark(kind, anchor, "left", "Café — naïve", "coach")])
    dashed = draw_marks(image, box, [OverlayMark(kind, anchor, "left", "Café — naïve", "ai")])
    assert ImageChops.difference(solid.convert("RGB"), dashed.convert("RGB")).getbbox()
    assert solid.getpixel((0, 0)) == (255, 255, 255, 255)


def test_highlight_composites_and_top_label_is_valid() -> None:
    image = Image.new("RGB", (120, 120), "white")
    result = draw_marks(
        image, (10, 20, 90, 80), [OverlayMark("highlight", "box_top", None, "", "ai")]
    )
    assert result.convert("RGB").getpixel((50, 50)) == (210, 217, 202)
    label = draw_marks(
        image, (10, 0, 90, 80), [OverlayMark("label", "box_top", None, "é—naïve", "ai")]
    )
    assert label.getbbox() == (0, 0, 120, 120)


def test_frozen_numeric_geometry() -> None:
    fixture = json.loads(
        (Path(__file__).parents[2] / "fixtures/synthetic/overlay-geometry.json").read_text()
    )
    box = (10.0, 20.0, 90.0, 80.0)
    for anchor, expected in fixture["anchor"].items():
        assert list(anchor_point(box, anchor)) == expected
    for side, expected in fixture["arrows"].items():
        origin, head = arrow_geometry(box, "box_center", side)
        assert list(origin) == expected["origin"]
        assert [list(point) for point in head] == expected["head"]


@pytest.mark.parametrize(
    "side,pixel",
    [("left", (42, 50)), ("right", (58, 50)), ("above", (50, 42)), ("below", (50, 58))],
)
def test_arrow_head_faces_origin(side: str, pixel: tuple[int, int]) -> None:
    image = draw_marks(
        Image.new("RGB", (160, 160), "white"),
        (10, 20, 90, 80),
        [OverlayMark("arrow", "box_center", side, "", "coach")],
    )
    assert image.convert("RGB").getpixel(pixel) == (77, 103, 42)


def parsed_track(**changes: Any) -> TrackFile:
    value = json.loads(track())
    value.update(changes)
    return TrackFile.model_validate(value)


def test_still_lookup_and_gap_swap_boundaries() -> None:
    frame = {"ms": 499, "box": {"x1": 1, "y1": 1, "x2": 10, "y2": 10}, "conf": 1}
    render = worker(Storage({}))
    still = parsed_track(fps=0, frames=[dict(frame, ms=500)])
    assert render._box_at(still, 500) == (1, 1, 10, 10)
    assert render._box_at(still, 499) is None
    swapped = parsed_track(frames=[frame], swaps=[{"ms": 499, "reason": "jump"}])
    assert render._box_at(swapped, 500) is None
    gapped = parsed_track(frames=[frame], gaps=[[499, 500]])
    assert render._box_at(gapped, 500) is None
    boundary = parsed_track(frames=[dict(frame, ms=498)], gaps=[[499, 500]])
    assert render._box_at(boundary, 500) is None


@pytest.mark.parametrize(
    "change",
    [
        {"fps": float("inf")},
        {"fps": 0},
        {"frames": []},
        {"frames": [{"ms": 0, "box": {"x1": 3, "y1": 0, "x2": 2, "y2": 4}, "conf": 1}]},
        {"frames": [{"ms": 0, "box": {"x1": 0, "y1": 0, "x2": 161, "y2": 4}, "conf": 1}]},
        {"gaps": [[500, 400]]},
        {"gaps": [[200, 400], [300, 500]]},
        {"swaps": [{"ms": 2000, "reason": "jump"}]},
    ],
)
def test_malformed_track_rejected(change: dict[str, Any]) -> None:
    with pytest.raises(ValueError):
        validate_track(parsed_track(**change), 160, 120, 2000)


def test_duplicate_and_unordered_track_frames() -> None:
    value = json.loads(track())
    for frames in ([value["frames"][0]] * 2, list(reversed(value["frames"]))):
        with pytest.raises(ValueError):
            validate_track(parsed_track(frames=frames), 160, 120, 2000)


@pytest.mark.parametrize(
    "key",
    [
        "sessions/session_1/./proxy.mp4",
        "sessions/session_1/../proxy.mp4",
        "sessions/session_1/proxy.mp4?x",
        "sessions/session_1/proxy.mp4#x",
        "sessions/session_1/x\n",
        "sessions/session_1/%2e",
        "sessions/other/proxy.mp4",
        "sessions/session_1/a\\b",
    ],
)
def test_noncanonical_refs(key: str) -> None:
    assert not _safe_key(key, "session_1")


@pytest.mark.parametrize(
    "field,value",
    [
        ("annotationId", "../../escape"),
        ("annotationId", "a?x"),
        ("annotationId", "a\n"),
        ("trackFileRef", "sessions/session_1/proxy.mp4"),
    ],
)
def test_bad_annotation_rejected_before_io(field: str, value: str) -> None:
    mark = annotation()
    mark[field] = value
    storage = Storage({})
    assert (
        worker(storage).run(input_value([mark]), context(storage))["error_code"]
        == "CONTRACT_INVALID"
    )
    assert storage.puts == []


@pytest.fixture
def media(tmp_path: Path) -> Storage:
    source = tmp_path / "source.mp4"
    clip(source)
    return Storage(
        {
            "sessions/session_1/proxy.mp4": source.read_bytes(),
            "sessions/session_1/tracks/r1.json": track(),
        }
    )


def test_fps_zero_emits_actual_selected_jpeg(media: Storage) -> None:
    frame = json.loads(track())["frames"][0]
    frame["ms"] = 500
    media.objects["sessions/session_1/tracks/r1.json"] = json.dumps(
        {"fps": 0, "subjectOnly": True, "frames": [frame], "gaps": [], "swaps": []}
    ).encode()
    value = input_value([annotation()])
    value["mode"] = "stills"
    result = worker(media).run(value, context(media))
    assert result["status"] == "done"
    output = cast(dict[str, Any], result["output"])
    assert output["stillRefs"] == [
        {"annotationId": "a1", "key": "sessions/session_1/stills/a1.jpg"}
    ]
    assert media.objects[output["stillRefs"][0]["key"]].startswith(b"\xff\xd8")


def test_missing_still_frame_fails_instead_of_silent_omission(media: Storage) -> None:
    value = input_value([annotation(start=1999, end=2000)])
    value["mode"] = "stills"
    assert worker(media).run(value, context(media))["error_code"] == "RENDER_FAIL"


def video_info(data: bytes, tmp_path: Path) -> dict[str, Any]:
    file = tmp_path / "output.mp4"
    file.write_bytes(data)
    return cast(
        dict[str, Any],
        json.loads(
            subprocess.check_output(
                [
                    "ffprobe",
                    "-v",
                    "error",
                    "-show_format",
                    "-show_streams",
                    "-of",
                    "json",
                    str(file),
                ]
            )
        ),
    )


def test_non_aligned_cuts_full_duration_and_exact_source_audio(
    media: Storage, tmp_path: Path
) -> None:
    marks = [annotation("a", 301, 401), annotation("b", 1501, 1801)]
    value = input_value(marks)
    result = worker(media).run(value, context(media))
    assert result["status"] == "done"
    output = cast(dict[str, Any], result["output"])
    data = media.objects[output["fileRef"]]
    assert output["fileRef"] == "sessions/session_1/renders/preview/full.mp4"
    info = video_info(data, tmp_path)
    assert abs(float(info["format"]["duration"]) - 2) <= 0.034
    video = next(s for s in info["streams"] if s["codec_type"] == "video")
    assert int(video["nb_frames"]) == 60
    assert data.index(b"moov") < data.index(b"mdat")
    # Remuxing the untouched source AAC packets preserves samples across every cut.
    source = tmp_path / "source.mp4"
    source.write_bytes(media.objects["sessions/session_1/proxy.mp4"])

    def audio(file: Path) -> bytes:
        return subprocess.check_output(
            [
                "ffmpeg",
                "-v",
                "error",
                "-i",
                str(file),
                "-map",
                "0:a:0",
                "-f",
                "s16le",
                "-acodec",
                "pcm_s16le",
                "-",
            ]
        )

    assert audio(tmp_path / "output.mp4") == audio(source)


def test_build_api_and_multiple_segment_cache_invalidation(media: Storage) -> None:
    marks = [annotation("a", 0, 100), annotation("b", 1200, 1300)]
    segments = build_segments([Annotation.model_validate(a) for a in marks], 2000)
    assert [s.segmentId for s in segments] == ["s-0-100", "s-1200-1300"]
    value = input_value(marks)
    value["segments"] = [s.model_dump() for s in segments]
    result = worker(media).run(value, context(media))
    assert result["status"] == "done"
    refs = cast(dict[str, Any], result["output"])["segmentRefs"]
    before = len(media.puts)
    value["previousSegments"] = refs
    assert worker(media).run(value, context(media))["status"] == "done"
    assert len(media.puts) - before == 3  # two JPEGs + full; no segment writes
    marks[0]["placedBy"] = "coach"
    value["annotations"] = cast(list[JsonValue], marks)
    value["segments"] = [
        s.model_dump() for s in build_segments([Annotation.model_validate(a) for a in marks], 2000)
    ]
    before = len(media.puts)
    assert worker(media).run(value, context(media))["status"] == "done"
    assert len([k for k in media.puts[before:] if "/renders/preview/s-0-100-" in k]) == 1
    assert refs[0]["key"] not in media.puts[before:]
    assert refs[1]["key"] not in media.puts[before:]
    # Corrupt the otherwise matching second cache object: it must be rebuilt.
    value["previousSegments"] = cast(
        dict[str, Any], worker(media).run(value, context(media))["output"]
    )["segmentRefs"]
    media.objects[refs[1]["key"]] = b"corrupt"
    before = len(media.puts)
    assert worker(media).run(value, context(media))["status"] == "done"
    assert refs[1]["key"] in media.puts[before:]
    del media.objects[refs[1]["key"]]
    assert worker(media).run(value, context(media))["status"] == "done"


@pytest.mark.parametrize("failure", ["probe-timeout", "download", "loader", "storage", "expired"])
def test_failures_are_scrubbed_and_workdir_cleaned(
    media: Storage, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, failure: str
) -> None:

    work = tmp_path / "render-work"

    def mkdir(**kwargs: Any) -> str:
        work.mkdir()
        return str(work)

    monkeypatch.setattr("netsense_runner.stages.s8_render.tempfile.mkdtemp", mkdir)

    def fail(*args: Any, **kwargs: Any) -> Any:
        raise RuntimeError("PRIVATE_INJECTED_ERROR")

    class TimeoutProbe:
        def run(self, command: tuple[str, ...], *, timeout_s: float) -> ToolResult:
            raise ToolExecutionError("STAGE_TIMEOUT")

    render = RenderWorker(
        download=fail
        if failure == "download"
        else lambda url, **limits: iter([media.objects[url.removeprefix("memory://")]]),
        track_loader=fail if failure == "loader" else lambda ref, **limits: media.objects[ref],
        tool=TimeoutProbe() if failure == "probe-timeout" else ToolAdapter(),
    )
    ctx = context(media)
    if failure == "storage":
        monkeypatch.setattr(media, "put_file", fail)
    if failure == "expired":
        ctx = replace(ctx, deadline_monotonic=time.monotonic() - 1)
    result = render.run(input_value([annotation()]), ctx)
    assert result["error_code"] == (
        "STAGE_TIMEOUT" if failure in {"probe-timeout", "expired"} else "RENDER_FAIL"
    )
    assert "PRIVATE" not in str(result)
    assert not work.exists()


def test_source_shape_validation() -> None:
    data: dict[str, Any] = {
        "format": {"duration": "2"},
        "streams": [{"codec_type": "video", "width": 160, "height": 120, "avg_frame_rate": "30/1"}],
    }
    assert media_shape(data, 2000) == (160, 120, 30)
    for field, value in [("width", 99999), ("height", 0), ("avg_frame_rate", "0/0")]:
        bad = json.loads(json.dumps(data))
        bad["streams"][0][field] = value
        with pytest.raises(ValueError):
            media_shape(bad, 2000)


def test_unicode_is_preserved_or_fails_without_replacement() -> None:
    image = Image.new("RGB", (240, 240), "white")
    plain = draw_marks(
        image, (50, 50, 160, 160), [OverlayMark("label", "box_top", None, "Cafe", "coach")]
    )
    unicode = draw_marks(
        image, (50, 50, 160, 160), [OverlayMark("label", "box_top", None, "Café —", "coach")]
    )
    assert ImageChops.difference(plain.convert("RGB"), unicode.convert("RGB")).getbbox()
    with pytest.raises(ValueError, match="RENDER_FONT_UNSUPPORTED"):
        draw_marks(
            image,
            (50, 50, 160, 160),
            [OverlayMark("label", "box_top", None, chr(0x10FFFF), "coach")],
        )


def test_incompatible_hash_and_bad_segment_ids_fail_before_io() -> None:
    storage = Storage({})
    value = input_value([annotation()])
    segments = cast(list[dict[str, Any]], value["segments"])
    segments[0]["hash"] = "0" * 64
    assert worker(storage).run(value, context(storage))["error_code"] == "CONTRACT_INVALID"
    for identifier in ["../x", "x#y", "", "a/b", "x\x00"]:
        value = input_value([annotation()])
        cast(list[dict[str, Any]], value["segments"])[0]["segmentId"] = identifier
        assert worker(storage).run(value, context(storage))["error_code"] == "CONTRACT_INVALID"
    assert (
        worker(storage).run(input_value([]), replace(context(storage), session_id="../bad"))[
            "error_code"
        ]
        == "CONTRACT_INVALID"
    )


def test_no_download_next_after_deadline(tmp_path: Path) -> None:
    calls: list[str] = []

    def download(url: str, **limits: float | int) -> Any:
        calls.append("iterator")
        yield b"never"

    render = RenderWorker(download=download, track_loader=lambda ref, **limits: b"")
    with pytest.raises(ToolExecutionError, match="STAGE_TIMEOUT"):
        render._download_to("unused", tmp_path / "target", time.monotonic() - 1)
    assert calls == []


def test_download_enforces_chunk_size_and_closes_generator(tmp_path: Path) -> None:
    closed: list[bool] = []

    def download(url: str, **limits: float | int) -> Any:
        try:
            yield b"x" * (1024 * 1024 + 1)
        finally:
            closed.append(True)

    render = RenderWorker(download=download, track_loader=lambda ref, **limits: b"")
    with pytest.raises(ValueError):
        render._download_to("unused", tmp_path / "target", time.monotonic() + 10)
    assert closed == [True]


def test_actual_timestamp_validation_rejects_vfr(media: Storage) -> None:
    class VfrTool:
        def run(self, command: tuple[str, ...], *, timeout_s: float) -> ToolResult:
            return ToolResult(stdout=b"0.000000\n0.033333\n0.100000\n", stderr="")

    render = RenderWorker(
        download=lambda url, **limits: iter([]),
        track_loader=lambda ref, **limits: b"",
        tool=VfrTool(),
    )
    with pytest.raises(ValueError):
        render._validate_cfr(Path("unused"), 30, context(media))


def test_bounded_batches_and_success_cleanup(
    media: Storage, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:

    work = tmp_path / "work"

    def mkdir(**kwargs: Any) -> str:
        work.mkdir()
        return str(work)

    monkeypatch.setattr("netsense_runner.stages.s8_render.tempfile.mkdtemp", mkdir)

    class RecordingTool:
        def __init__(self) -> None:
            self.commands: list[tuple[str, ...]] = []

        def run(self, command: tuple[str, ...], *, timeout_s: float) -> ToolResult:
            self.commands.append(command)
            return ToolAdapter().run(command, timeout_s=timeout_s)

    tool = RecordingTool()
    render = RenderWorker(
        download=lambda url, **limits: iter([media.objects[url.removeprefix("memory://")]]),
        track_loader=lambda ref, **limits: media.objects[ref],
        tool=tool,
    )
    result = render.run(input_value([annotation(start=0, end=2000)]), context(media))
    assert result["status"] == "done"
    extracts = [command for command in tool.commands if "-vsync" in command]
    assert len(extracts) == 2
    assert all(int(c[c.index("-frames:v") + 1]) <= 30 for c in extracts)
    assert not work.exists()


def test_cpu_loop_deadline_cleans_work(
    media: Storage, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import netsense_runner.stages.s8_render as module

    work = tmp_path / "work"

    def mkdir(**kwargs: Any) -> str:
        work.mkdir()
        return str(work)

    monkeypatch.setattr("netsense_runner.stages.s8_render.tempfile.mkdtemp", mkdir)
    real_draw = draw_marks
    drawings = 0

    def draw(*args: Any, **kwargs: Any) -> Image.Image:
        nonlocal drawings
        drawings += 1
        if drawings == 2:  # first video frame, after the still

            def expired(deadline: float) -> float:
                raise ToolExecutionError("STAGE_TIMEOUT")

            monkeypatch.setattr(module, "remaining_timeout", expired)
        return real_draw(*args, **kwargs)

    monkeypatch.setattr(module, "draw_marks", draw)
    result = worker(media).run(input_value([annotation()]), context(media))
    assert result["error_code"] == "STAGE_TIMEOUT"
    assert drawings == 2
    assert not work.exists()


def test_bounded_loader_and_expiry_after_io(
    media: Storage, monkeypatch: pytest.MonkeyPatch
) -> None:
    import netsense_runner.stages.s8_render as module

    render = RenderWorker(
        download=lambda url, **limits: iter([]),
        track_loader=lambda ref, **limits: b"x" * (1024 * 1024 + 1),
    )
    with pytest.raises(ValueError):
        render._tracks(
            [Annotation.model_validate(annotation())], "session_1", time.monotonic() + 10
        )

    def load(ref: str, **limits: float | int) -> bytes:
        def expired(deadline: float) -> float:
            raise ToolExecutionError("STAGE_TIMEOUT")

        monkeypatch.setattr(module, "remaining_timeout", expired)
        return track()

    render = RenderWorker(download=lambda url, **limits: iter([]), track_loader=load)
    with pytest.raises(ToolExecutionError, match="STAGE_TIMEOUT"):
        render._tracks(
            [Annotation.model_validate(annotation())], "session_1", time.monotonic() + 10
        )


@pytest.mark.parametrize(
    "anchor,target",
    [
        ("box_center", (50, 50)),
        ("box_top", (50, 20)),
        ("box_bottom", (50, 80)),
        ("box_left", (10, 50)),
        ("box_right", (90, 50)),
    ],
)
@pytest.mark.parametrize("side", ["left", "right", "above", "below"])
def test_all_arrow_anchor_side_coordinates(anchor: str, target: tuple[int, int], side: str) -> None:
    x, y = target
    expected = {
        "left": ((-26, y), (target, (x - 8, y + 5), (x - 8, y - 5))),
        "right": ((126, y), (target, (x + 8, y - 5), (x + 8, y + 5))),
        "above": ((x, -16), (target, (x - 5, y - 8), (x + 5, y - 8))),
        "below": ((x, 116), (target, (x + 5, y + 8), (x - 5, y + 8))),
    }
    assert arrow_geometry((10, 20, 90, 80), anchor, side) == expected[side]


def test_real_render_half_open_pixels(tmp_path: Path) -> None:
    source = tmp_path / "white.mp4"
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=white:size=160x120:rate=30",
            "-t",
            "2",
            "-c:v",
            "libx264",
            str(source),
        ],
        check=True,
    )
    storage = Storage(
        {
            "sessions/session_1/proxy.mp4": source.read_bytes(),
            "sessions/session_1/tracks/r1.json": track(),
        }
    )
    mark = annotation(start=301, end=400)
    mark["markType"] = "highlight"
    result = worker(storage).run(input_value([mark]), context(storage))
    assert result["status"] == "done"
    output = cast(dict[str, Any], result["output"])
    rendered = tmp_path / "render.mp4"
    rendered.write_bytes(storage.objects[output["fileRef"]])
    pixels = subprocess.check_output(
        [
            "ffmpeg",
            "-v",
            "error",
            "-i",
            str(rendered),
            "-vf",
            r"select=between(n\,9\,12)",
            "-vsync",
            "0",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-",
        ]
    )
    size = 160 * 120 * 3
    center = (60 * 160 + 65) * 3
    colors = [tuple(pixels[i * size + center : i * size + center + 3]) for i in range(4)]
    assert all(c >= 245 for c in colors[0] + colors[3])  # 300 and 400ms excluded
    assert all(190 < c < 235 for c in colors[1] + colors[2])  # 333 and 366ms blended


@pytest.mark.parametrize("fault", ["dimensions", "timebase", "duration"])
def test_wrong_cached_media_rebuilds(media: Storage, tmp_path: Path, fault: str) -> None:
    value = input_value([annotation()])
    result = worker(media).run(value, context(media))
    assert result["status"] == "done"
    refs = cast(dict[str, Any], result["output"])["segmentRefs"]
    source = tmp_path / "cached.mp4"
    source.write_bytes(media.objects[refs[0]["key"]])
    wrong = tmp_path / "wrong.mp4"
    options = {
        "dimensions": ["-vf", "scale=80:60", "-c:v", "libx264", "-video_track_timescale", "90000"],
        "timebase": ["-c:v", "copy", "-video_track_timescale", "1000"],
        "duration": ["-t", "0.1", "-c:v", "libx264", "-video_track_timescale", "90000"],
    }[fault]
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-i", str(source), *options, str(wrong)], check=True
    )
    media.objects[refs[0]["key"]] = wrong.read_bytes()
    value["previousSegments"] = refs
    before = len(media.puts)
    assert worker(media).run(value, context(media))["status"] == "done"
    assert refs[0]["key"] in media.puts[before:]


def test_vfr_is_explicitly_normalized_and_probed(tmp_path: Path) -> None:
    source = tmp_path / "vfr.mp4"
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=160x120:rate=30",
            "-vf",
            "settb=1/1000,setpts=N*33+mod(N\\,2)*10",
            "-fps_mode",
            "vfr",
            "-enc_time_base",
            "1/1000",
            "-t",
            "2",
            "-c:v",
            "libx264",
            str(source),
        ],
        check=True,
    )
    storage = Storage(
        {
            "sessions/session_1/proxy.mp4": source.read_bytes(),
            "sessions/session_1/tracks/r1.json": track(),
        }
    )
    result = worker(storage).run(input_value([annotation()]), context(storage))
    assert result["status"] == "done"
    output = cast(dict[str, Any], result["output"])
    info = video_info(storage.objects[output["fileRef"]], tmp_path)
    video = next(s for s in info["streams"] if s["codec_type"] == "video")
    assert video["avg_frame_rate"] == "30/1"
    assert int(video["nb_frames"]) == 60
    assert abs(float(info["format"]["duration"]) - 2) <= 0.034


def test_io_receives_explicit_bounds(tmp_path: Path) -> None:
    limits_seen: list[dict[str, float | int]] = []

    def download(url: str, **limits: float | int) -> Any:
        limits_seen.append(limits)
        yield b"data"

    def load(ref: str, **limits: float | int) -> bytes:
        limits_seen.append(limits)
        return track()

    render = RenderWorker(download=download, track_loader=load)
    deadline = time.monotonic() + 10
    render._download_to("unused", tmp_path / "target", deadline)
    render._tracks([Annotation.model_validate(annotation())], "session_1", deadline)
    assert [v["max_bytes"] for v in limits_seen] == [2 * 1024**3, 1024**2]
    assert all(0 < v["timeout_s"] <= 10 for v in limits_seen)


def test_long_unicode_label_fits_without_rewriting(monkeypatch: pytest.MonkeyPatch) -> None:
    from PIL import ImageDraw

    original = ImageDraw.ImageDraw.text
    seen: list[str] = []

    def capture(self: ImageDraw.ImageDraw, xy: Any, text: Any, *args: Any, **kwargs: Any) -> None:
        seen.append(text)
        original(self, xy, text, *args, **kwargs)

    monkeypatch.setattr(ImageDraw.ImageDraw, "text", capture)
    label = "Café — " * 8
    result = draw_marks(
        Image.new("RGB", (120, 120), "white"),
        (110, 0, 119, 100),
        [OverlayMark("label", "box_top", None, label, "coach")],
    )
    assert seen == [label]
    assert result.size == (120, 120)
