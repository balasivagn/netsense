from __future__ import annotations

import json
import subprocess
import time
from pathlib import Path
from typing import Any, cast

from netsense_runner.budget import Budget
from netsense_runner.context import StageContext
from netsense_runner.json_types import JsonValue
from netsense_runner.media.overlay_draw import OverlayMark, anchor_point, draw_marks
from netsense_runner.media.segments import canonical_hash, merged_ranges
from netsense_runner.registry import ProviderRegistry
from netsense_runner.stages.s8_render import RenderWorker


class Ledger:
    def reserve(self, amount_usd: float, daily_limit_usd: float) -> bool:
        return amount_usd <= daily_limit_usd


class Storage:
    def __init__(self, objects: dict[str, bytes]) -> None:
        self.objects = objects
        self.puts: list[str] = []

    def get_url(self, key: str) -> str:
        return f"memory://{key}"

    def put_bytes(self, key: str, data: bytes, content_type: str) -> None:
        self.objects[key] = data
        self.puts.append(key)

    def put_file(self, key: str, path: str, content_type: str) -> None:
        self.put_bytes(key, Path(path).read_bytes(), content_type)


class Api:
    def heartbeat(self) -> None:
        pass


class Log:
    def event(self, name: str, **fields: str | int | float | bool | None) -> None:
        pass


def context(storage: Storage) -> StageContext:
    from netsense_runner.contracts.PipelineConfig import PipelineConfig

    config = PipelineConfig.model_validate(
        json.loads((Path(__file__).parents[2] / "config/pipeline_config.v1.json").read_text())
    )
    return StageContext(
        "job",
        "session_1",
        1,
        "run",
        None,
        1,
        time.monotonic() + 90,
        Budget(config.limits, Ledger()),
        storage,
        Api(),
        ProviderRegistry({}),
        Log(),
    )


def clip(path: Path) -> None:
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
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440",
            "-t",
            "2",
            "-c:v",
            "libx264",
            "-c:a",
            "aac",
            str(path),
        ],
        check=True,
    )


def track() -> bytes:
    frames = [
        {"ms": ms, "box": {"x1": 30, "y1": 20, "x2": 100, "y2": 100}, "conf": 1}
        for ms in range(0, 2000, 33)
    ]
    return json.dumps(
        {"fps": 30, "subjectOnly": True, "frames": frames, "gaps": [], "swaps": []}
    ).encode()


def input_value(
    annotations: list[dict[str, Any]], *, previous: list[dict[str, Any]] | None = None
) -> dict[str, JsonValue]:
    ranges = merged_ranges(annotations, 2000)
    return {
        "kind": "preview",
        "mode": "video",
        "proxyKey": "sessions/session_1/proxy.mp4",
        "durationMs": 2000,
        "segments": [
            {
                "segmentId": f"s{idx}",
                "startMs": item.start_ms,
                "endMs": item.end_ms,
                "annotationIds": list(item.annotation_ids),
                "hash": item.digest,
            }
            for idx, item in enumerate(ranges)
        ],
        "annotations": cast(list[JsonValue], annotations),
        "previousSegments": cast(list[JsonValue], previous or []),
    }


def annotation(annotation_id: str = "a1", start: int = 300, end: int = 700) -> dict[str, Any]:
    return {
        "annotationId": annotation_id,
        "markType": "circle",
        "anchor": "box_top",
        "arrowFrom": None,
        "startMs": start,
        "endMs": end,
        "labelText": "",
        "placedBy": "ai",
        "trackFileRef": "sessions/session_1/tracks/r1.json",
    }


def worker(storage: Storage) -> RenderWorker:
    return RenderWorker(
        download=lambda url: iter([storage.objects[url.removeprefix("memory://")]]),
        track_loader=lambda key: storage.objects[key],
        object_exists=lambda key: key in storage.objects,
    )


def test_geometry_fixture_and_dashed_pixels() -> None:
    assert anchor_point((10, 20, 90, 80), "box_top") == (50, 20)
    from PIL import Image

    solid = draw_marks(
        Image.new("RGB", (120, 120)),
        (10, 20, 90, 80),
        [OverlayMark("circle", "box_top", None, "", "coach")],
    )
    dashed = draw_marks(
        Image.new("RGB", (120, 120)),
        (10, 20, 90, 80),
        [OverlayMark("circle", "box_top", None, "", "ai")],
    )
    assert cast(tuple[int, int, int, int], solid.getpixel((62, 20)))[3] > 0
    assert cast(tuple[int, int, int, int], dashed.getpixel((62, 20)))[3] == 255
    assert (
        json.loads(
            (Path(__file__).parents[2] / "fixtures/synthetic/overlay-geometry.json").read_text()
        )["timeWindows"]
        == "half-open [startMs,endMs)"
    )


def test_real_render_has_audio_faststart_still_and_reuse(tmp_path: Path) -> None:
    source = tmp_path / "source.mp4"
    clip(source)
    storage = Storage(
        {
            "sessions/session_1/proxy.mp4": source.read_bytes(),
            "sessions/session_1/tracks/r1.json": track(),
        }
    )
    result = worker(storage).run(input_value([annotation()]), context(storage))
    assert result["status"] == "done"
    output = cast(dict[str, object], result["output"])
    rendered = tmp_path / "rendered.mp4"
    rendered.write_bytes(storage.objects[cast(str, output["fileRef"])])
    probe = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration:stream=codec_type,codec_name",
            "-of",
            "json",
            str(rendered),
        ],
        capture_output=True,
        check=True,
        text=True,
    ).stdout
    assert (
        "h264" in probe and "aac" in probe and float(json.loads(probe)["format"]["duration"]) > 1.7
    )
    assert b"moov" in rendered.read_bytes()[:4096]
    assert len(cast(list[object], output["stillRefs"])) == 1
    segment_refs = cast(list[dict[str, object]], output["segmentRefs"])
    previous = [
        {
            "segmentId": segment_refs[0]["segmentId"],
            "hash": segment_refs[0]["hash"],
            "key": segment_refs[0]["key"],
        }
    ]
    before = len([key for key in storage.puts if "/segments/" in key])
    reused = worker(storage).run(input_value([annotation()], previous=previous), context(storage))
    assert reused["status"] == "done"
    assert len([key for key in storage.puts if "/segments/" in key]) == before


def test_empty_annotations_preserves_video_and_rejects_foreign_track(tmp_path: Path) -> None:
    source = tmp_path / "source.mp4"
    clip(source)
    storage = Storage({"sessions/session_1/proxy.mp4": source.read_bytes()})
    result = worker(storage).run(input_value([]), context(storage))
    assert result["status"] == "done"
    bad = annotation()
    bad["trackFileRef"] = "sessions/other/tracks/r1.json"
    assert (
        worker(storage).run(input_value([bad]), context(storage))[
            "error_code"
        ]
        == "CONTRACT_INVALID"
    )


def test_segments_merge_only_gaps_less_than_one_second() -> None:
    first, second = annotation("a", 0, 100), annotation("b", 1100, 1200)
    assert len(merged_ranges([first, second], 2000)) == 2
    second["startMs"] = 1099
    assert len(merged_ranges([first, second], 2000)) == 1
    assert canonical_hash(0, 1, []) == canonical_hash(0, 1, [])
