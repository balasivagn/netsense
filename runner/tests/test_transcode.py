from __future__ import annotations

import hashlib
import json
import subprocess
import time
from collections.abc import Iterator
from dataclasses import replace
from pathlib import Path
from typing import cast

import pytest

from netsense_runner.adapters.tool import ToolResult
from netsense_runner.budget import Budget
from netsense_runner.context import StageContext
from netsense_runner.contracts.PipelineConfig import PipelineConfig
from netsense_runner.json_types import JsonValue
from netsense_runner.registry import ProviderRegistry
from netsense_runner.stage import StageWorker
from netsense_runner.stages.s0_transcode import TranscodeWorker, _http_download, wav_chunk_ranges

ROOT = Path(__file__).resolve().parents[2]


class Ledger:
    def reserve(self, amount_usd: float, daily_limit_usd: float) -> bool:
        return amount_usd <= daily_limit_usd


class Storage:
    def __init__(self) -> None:
        self.uploaded: dict[str, tuple[bytes, str]] = {}
        self.url_requests: list[str] = []

    def get_url(self, key: str) -> str:
        self.url_requests.append(key)
        return "https://storage.invalid/signed-upload"

    def put_bytes(self, key: str, data: bytes, content_type: str) -> None:
        self.uploaded[key] = (data, content_type)

    def put_file(self, key: str, path: str, content_type: str) -> None:
        self.uploaded[key] = (Path(path).read_bytes(), content_type)


class Api:
    def persist_stage_output(self, stage_run_id: str, output_ref: str) -> None:
        raise AssertionError("stage persistence belongs to the DAG")

    def report_stage_usage(self, stage_run_id: str, cost_usd: float) -> None:
        raise AssertionError("stage usage persistence belongs to the DAG")


class Log:
    def event(self, name: str, **fields: str | int | float | bool | None) -> None:
        return None


def context(storage: Storage) -> StageContext:
    config = PipelineConfig.model_validate(
        json.loads((ROOT / "config/pipeline_config.v1.json").read_text())
    )
    return StageContext(
        job_id="job",
        session_id="session_1",
        config_version=1,
        stage_run_id="run",
        remark_id=None,
        attempt=1,
        deadline_monotonic=time.monotonic() + 120,
        budget=Budget(config.limits, Ledger()),
        storage=storage,
        convex=Api(),
        providers=ProviderRegistry({}),
        log=Log(),
    )


def input_for(data: bytes) -> dict[str, JsonValue]:
    return {
        "uploadId": "upload",
        "sourceKey": "sessions/session_1/source.mp4",
        "declaredBytes": len(data),
        "declaredSha256": hashlib.sha256(data).hexdigest(),
        "mimeType": "video/mp4",
    }


def done_output(result: object) -> dict[str, JsonValue]:
    result_map = cast(dict[str, object], result)
    output = result_map["output"]
    assert isinstance(output, dict)
    return cast(dict[str, JsonValue], output)


def chunks(data: bytes) -> Iterator[bytes]:
    yield from (data[:13], data[13:])


def make_clip(
    path: Path, *, container: str = "mp4", video: bool = True, audio: bool = True
) -> None:
    command = ["ffmpeg", "-y", "-v", "error"]
    if video:
        command += ["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30"]
    if audio:
        command += ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000"]
    command += ["-t", "2"]
    if video:
        command += ["-c:v", "libx264"]
    if audio:
        command += ["-c:a", "aac"]
    command += [str(path)]
    subprocess.run(command, check=True)


def test_transcode_mp4_generates_contract_valid_derivatives(tmp_path: Path) -> None:
    source = tmp_path / "source.mp4"
    make_clip(source)
    data = source.read_bytes()
    storage = Storage()
    result = TranscodeWorker(download=lambda _url: chunks(data)).run(
        input_for(data), context(storage)
    )

    assert result["status"] == "done"
    output = done_output(result)
    assert output["sha256Verified"] is True
    assert output["width"] == 1280
    assert output["height"] == 720
    assert output["fps"] == pytest.approx(30)
    assert cast(int, output["durationMs"]) >= 1900
    proxy = tmp_path / "proxy.mp4"
    proxy.write_bytes(storage.uploaded["sessions/session_1/proxy.mp4"][0])
    details = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=format_name:stream=codec_name",
            "-of",
            "json",
            str(proxy),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    assert "h264" in details.stdout and "aac" in details.stdout
    assert (
        b"moov" in proxy.read_bytes()[:4096]
    )  # faststart puts movie metadata before media payload.
    audio_keys = cast(list[dict[str, JsonValue]], output["audioWavKeys"])
    wav_key = cast(str, audio_keys[0]["key"])
    wav = tmp_path / "audio.wav"
    wav.write_bytes(storage.uploaded[wav_key][0])
    wav_details = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "stream=codec_name,channels,sample_rate",
            "-of",
            "json",
            str(wav),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    assert '"pcm_s16le"' in wav_details.stdout
    assert '"channels": 1' in wav_details.stdout
    assert '"24000"' in wav_details.stdout
    frames = json.loads(storage.uploaded["sessions/session_1/keyframes.json"][0])
    assert frames[0] == {"idx": 0, "ms": 0, "key": "sessions/session_1/keyframes/0.jpg"}
    assert all(frame["ms"] == frame["idx"] * 500 for frame in frames)


def test_transcode_webm_normalizes_to_h264_aac(tmp_path: Path) -> None:
    source = tmp_path / "source.webm"
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=640x360:rate=30",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000",
            "-t",
            "2",
            "-c:v",
            "libvpx-vp9",
            "-c:a",
            "libopus",
            str(source),
        ],
        check=True,
    )
    data = source.read_bytes()
    result = TranscodeWorker(download=lambda _url: chunks(data)).run(
        input_for(data), context(Storage())
    )
    assert result["status"] == "done"


def test_hevc_mov_if_supported_is_explicitly_skipped_or_normalized(tmp_path: Path) -> None:
    encoders = subprocess.run(
        ["ffmpeg", "-hide_banner", "-encoders"], capture_output=True, text=True, check=True
    )
    if "libx265" not in encoders.stdout:
        pytest.skip("UNTESTED: local ffmpeg does not provide libx265")
    source = tmp_path / "source.mov"
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=640x360:rate=30",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000",
            "-t",
            "2",
            "-c:v",
            "libx265",
            "-tag:v",
            "hvc1",
            "-c:a",
            "aac",
            str(source),
        ],
        check=True,
    )
    data = source.read_bytes()
    assert (
        TranscodeWorker(download=lambda _url: chunks(data)).run(
            input_for(data), context(Storage())
        )["status"]
        == "done"
    )


@pytest.mark.parametrize("wrong", [b"short", b"this is too long"])
def test_checksum_and_size_rejection_happen_before_tools_or_uploads(wrong: bytes) -> None:
    expected = b"correct"
    storage = Storage()

    class ForbiddenTool:
        def run(self, command: tuple[str, ...], *, timeout_s: float) -> ToolResult:
            raise AssertionError("ffmpeg must not run before checksum verification")

    result = TranscodeWorker(download=lambda _url: iter((wrong,)), tool=ForbiddenTool()).run(
        input_for(expected), context(storage)
    )
    assert result["error_code"] == "UPLOAD_CHECKSUM"
    assert storage.uploaded == {}


def test_corrupt_and_audio_less_clips_map_to_decode_errors(tmp_path: Path) -> None:
    corrupt = b"not media"
    assert (
        TranscodeWorker(download=lambda _url: iter((corrupt,))).run(
            input_for(corrupt), context(Storage())
        )["error_code"]
        == "VIDEO_DECODE"
    )
    video_only = tmp_path / "video-only.mp4"
    make_clip(video_only, audio=False)
    data = video_only.read_bytes()
    assert (
        TranscodeWorker(download=lambda _url: chunks(data)).run(
            input_for(data), context(Storage())
        )["error_code"]
        == "AUDIO_DECODE"
    )


def test_timeout_and_temp_cleanup(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    made = tmp_path / "worker-temp"
    monkeypatch.setattr(
        "netsense_runner.stages.s0_transcode.tempfile.mkdtemp", lambda prefix: str(made)
    )
    made.mkdir()
    payload = b"x"

    class TimeoutTool:
        def run(self, command: tuple[str, ...], *, timeout_s: float) -> ToolResult:
            from netsense_runner.adapters.tool import ToolExecutionError

            raise ToolExecutionError("STAGE_TIMEOUT")

    result = TranscodeWorker(download=lambda _url: iter((payload,)), tool=TimeoutTool()).run(
        input_for(payload), context(Storage())
    )
    assert result["error_code"] == "STAGE_TIMEOUT"
    assert not made.exists()


def test_wav_chunk_ranges_keep_offsets_contiguous_and_final_chunk_short() -> None:
    ranges = wav_chunk_ranges(1_140_123)
    assert ranges == [(0, 570_000), (570_000, 570_000), (1_140_000, 123)]
    assert all(duration <= 570_000 for _, duration in ranges)


@pytest.mark.parametrize(
    "key",
    [
        "sessions/other/source",
        "sessions/session_1/../source",
        "sessions/session_1/%2e%2e/source",
        "sessions/session_1/dir\\source",
        "sessions/session_1/source\n",
        "sessions/session_1//source",
    ],
)
def test_invalid_storage_keys_fail_before_signing(key: str) -> None:
    storage = Storage()
    value = {**input_for(b"x"), "sourceKey": key}
    worker: StageWorker = TranscodeWorker()
    assert worker.run(value, context(storage))["error_code"] == "CONTRACT_INVALID"
    assert not storage.url_requests
    assert not storage.uploaded


def test_expired_deadline_fails_before_signing_or_downloading() -> None:
    storage = Storage()
    ctx = replace(context(storage), deadline_monotonic=time.monotonic() - 1)
    result = TranscodeWorker().run(input_for(b"x"), ctx)
    assert result["error_code"] == "STAGE_TIMEOUT"
    assert not storage.url_requests


def test_download_failure_does_not_return_raw_exception() -> None:
    def broken_download(_url: str) -> Iterator[bytes]:
        raise RuntimeError("private transport response")
        yield b""  # pragma: no cover

    result = TranscodeWorker(download=broken_download).run(input_for(b"x"), context(Storage()))
    assert result["error_code"] == "INFRA_NETWORK"
    assert "private transport response" not in str(result)


def test_download_checks_elapsed_deadline_between_chunks(monkeypatch: pytest.MonkeyPatch) -> None:
    clock = [0.0]
    storage = Storage()
    ctx = replace(context(storage), deadline_monotonic=10.0)
    monkeypatch.setattr("netsense_runner.media.ffmpeg.time.monotonic", lambda: clock[0])

    def slow_download(_url: str) -> Iterator[bytes]:
        yield b"a"
        clock[0] = 11.0
        yield b"b"

    result = TranscodeWorker(download=slow_download).run(input_for(b"ab"), ctx)
    assert result["error_code"] == "STAGE_TIMEOUT"
    assert not storage.uploaded


def test_http_download_bounds_socket_wait_and_closes_response(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    waits: list[float] = []

    class Response:
        closed = False
        chunks = iter((b"a", b"b", b""))

        def __enter__(self) -> Response:
            return self

        def __exit__(self, *_args: object) -> None:
            self.closed = True

        def read1(self, _size: int) -> bytes:
            return next(self.chunks)

    response = Response()

    def open_url(_url: str, *, timeout: float) -> Response:
        waits.append(timeout)
        return response

    monkeypatch.setattr("netsense_runner.stages.s0_transcode.urllib.request.urlopen", open_url)
    assert (
        b"".join(
            _http_download(
                "https://storage.invalid/source", deadline_monotonic=time.monotonic() + 10
            )
        )
        == b"ab"
    )
    assert waits == [1.0]
    assert response.closed
    with pytest.raises(RuntimeError, match="INFRA_NETWORK"):
        list(_http_download("file:///not-a-signed-url", deadline_monotonic=time.monotonic() + 10))
    assert waits == [1.0]
