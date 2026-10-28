"""Stage 0: validate an upload, make normalized media derivatives, and store them."""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import tempfile
import urllib.error
import urllib.request
from collections.abc import Callable, Iterator, Mapping
from pathlib import Path
from typing import cast
from urllib.parse import urlsplit

from netsense_runner.adapters.tool import ToolAdapter, ToolExecutionError
from netsense_runner.context import StageContext
from netsense_runner.contract_validation import validate_contract
from netsense_runner.json_types import JsonValue
from netsense_runner.media.ffmpeg import (
    MediaProbeError,
    ToolRunner,
    extract_m4a,
    extract_wav,
    frame_rate,
    positive_float,
    probe,
    remaining_timeout,
    stream,
    transcode_proxy,
)
from netsense_runner.media.keyframes import extract_keyframes
from netsense_runner.stage import StageKey, StageResult, Usage, WorkerType

_SESSION_ID = re.compile(r"^[A-Za-z0-9_-]+$")
_CHUNK_SECONDS = 570.0
_MAX_WAV_BYTES = 32 * 1024 * 1024

Download = Callable[[str], Iterator[bytes]]


def _http_download(url: str, *, deadline_monotonic: float) -> Iterator[bytes]:
    """Stream the signed URL supplied by storage, never a constructed endpoint."""
    try:
        address = urlsplit(url)
        if address.scheme not in {"http", "https"} or not address.hostname:
            raise RuntimeError("INFRA_NETWORK")
        # Bound stalls as well as total elapsed time. read1 returns after one
        # underlying read, so a slow stream cannot hide inside a large read().
        timeout = min(1.0, remaining_timeout(deadline_monotonic))
        with urllib.request.urlopen(url, timeout=timeout) as response:
            while True:
                remaining_timeout(deadline_monotonic)
                chunk = response.read1(1024 * 1024)
                if not chunk:
                    break
                yield chunk
    except (OSError, urllib.error.URLError, urllib.error.HTTPError):
        raise RuntimeError("INFRA_NETWORK") from None


def _empty_usage() -> Usage:
    return {"samFrames": 0, "inputTokens": 0, "outputTokens": 0, "audioSeconds": 0}


def _failure(code: str) -> StageResult:
    return {
        "status": "failed",
        "output": None,
        "error_code": code,
        "usage": _empty_usage(),
        "cost_usd": 0.0,
        "trace": None,
    }


def _safe_key(key: str, session_id: str) -> bool:
    prefix = f"sessions/{session_id}/"
    parts = key.split("/")
    return (
        key.startswith(prefix)
        and bool(key)
        and not key.startswith("/")
        and not any(character in key for character in ("%", "\\"))
        and not any(ord(character) < 32 or ord(character) == 127 for character in key)
        and all(part not in {"", ".", ".."} for part in parts)
    )


def _duration_ms(probe_data: Mapping[str, object]) -> int | None:
    format_data = probe_data.get("format")
    if not isinstance(format_data, Mapping):
        return None
    duration = positive_float(format_data.get("duration"))
    return round(duration * 1000) if duration is not None else None


def _video_metrics(probe_data: Mapping[str, object]) -> tuple[int, int, float, int] | None:
    video = stream(probe_data, "video")
    if video is None:
        return None
    width = video.get("width")
    height = video.get("height")
    fps = frame_rate(video.get("avg_frame_rate")) or frame_rate(video.get("r_frame_rate"))
    duration = _duration_ms(probe_data)
    if not isinstance(width, int) or not isinstance(height, int) or fps is None or duration is None:
        return None
    raw_count = video.get("nb_read_frames")
    try:
        frame_count = int(cast(str | int, raw_count))
    except (TypeError, ValueError):
        frame_count = round((duration / 1000) * fps)
    return width, height, fps, max(frame_count, 0)


def wav_chunk_ranges(duration_ms: int) -> list[tuple[int, int]]:
    """Return contiguous, Voice-Transcribe-safe chunk offsets and durations."""
    if duration_ms <= 0:
        return []
    maximum_ms = int(_CHUNK_SECONDS * 1000)
    return [
        (offset_ms, min(maximum_ms, duration_ms - offset_ms))
        for offset_ms in range(0, duration_ms, maximum_ms)
    ]


class TranscodeWorker:
    id: str = "transcode.ffmpeg@1"
    stage: StageKey = "transcode"
    worker_type: WorkerType = "tool"
    input_contract = "TranscodeInput"
    output_contract = "TranscodeOutput"

    def __init__(self, *, download: Download | None = None, tool: ToolRunner | None = None) -> None:
        self._download = download
        self._tool = tool or ToolAdapter()

    def _download_verified(
        self,
        url: str,
        target: Path,
        declared_bytes: int,
        declared_sha256: str,
        deadline_monotonic: float,
    ) -> None:
        digest = hashlib.sha256()
        total = 0
        try:
            remaining_timeout(deadline_monotonic)
            incoming = (
                self._download(url)
                if self._download is not None
                else _http_download(url, deadline_monotonic=deadline_monotonic)
            )
            with target.open("wb") as output:
                for chunk in incoming:
                    remaining_timeout(deadline_monotonic)
                    if not isinstance(chunk, bytes):
                        raise RuntimeError("INFRA_NETWORK")
                    total += len(chunk)
                    if total > declared_bytes:
                        raise ValueError("UPLOAD_CHECKSUM")
                    digest.update(chunk)
                    output.write(chunk)
        except ValueError:
            raise
        except ToolExecutionError:
            raise
        except (OSError, RuntimeError):
            raise RuntimeError("INFRA_NETWORK") from None
        remaining_timeout(deadline_monotonic)
        if total != declared_bytes or digest.hexdigest() != declared_sha256:
            raise ValueError("UPLOAD_CHECKSUM")

    def run(self, input_value: Mapping[str, JsonValue], ctx: StageContext) -> StageResult:
        try:
            validated_input = validate_contract("TranscodeInput", json.dumps(input_value))
        except (ValueError, TypeError):
            return _failure("CONTRACT_INVALID")
        values = validated_input
        source_key = cast(str, getattr(values, "sourceKey"))
        session_id = ctx.session_id
        if not _SESSION_ID.fullmatch(session_id) or not _safe_key(source_key, session_id):
            return _failure("CONTRACT_INVALID")

        prefix = f"sessions/{session_id}"
        proxy_key = f"{prefix}/proxy.mp4"
        m4a_key = f"{prefix}/audio.m4a"
        index_key = f"{prefix}/keyframes.json"
        work_dir = Path(tempfile.mkdtemp(prefix="netsense-transcode-"))
        try:
            remaining_timeout(ctx.deadline_monotonic)
            source = work_dir / "source"
            try:
                source_url = ctx.storage.get_url(source_key)
                self._download_verified(
                    source_url,
                    source,
                    cast(int, getattr(values, "declaredBytes")),
                    cast(str, getattr(values, "declaredSha256")),
                    ctx.deadline_monotonic,
                )
            except ValueError:
                return _failure("UPLOAD_CHECKSUM")
            except ToolExecutionError:
                raise
            except (RuntimeError, OSError):
                return _failure("INFRA_NETWORK")

            try:
                source_probe = probe(source, self._tool, ctx.deadline_monotonic)
            except MediaProbeError as error:
                return _failure(
                    "STAGE_TIMEOUT" if error.error_code == "STAGE_TIMEOUT" else "VIDEO_DECODE"
                )
            if stream(source_probe, "video") is None:
                return _failure("VIDEO_DECODE")
            if stream(source_probe, "audio") is None:
                return _failure("AUDIO_DECODE")

            proxy = work_dir / "proxy.mp4"
            try:
                transcode_proxy(source, proxy, self._tool, ctx.deadline_monotonic)
                proxy_probe = probe(proxy, self._tool, ctx.deadline_monotonic)
            except ToolExecutionError as error:
                return _failure(
                    error.error_code if error.error_code == "STAGE_TIMEOUT" else "VIDEO_DECODE"
                )
            except MediaProbeError as error:
                return _failure(
                    "STAGE_TIMEOUT" if error.error_code == "STAGE_TIMEOUT" else "VIDEO_DECODE"
                )
            metrics = _video_metrics(proxy_probe)
            duration_ms = _duration_ms(proxy_probe)
            if metrics is None or duration_ms is None or stream(proxy_probe, "audio") is None:
                return _failure("VIDEO_DECODE")

            m4a = work_dir / "audio.m4a"
            try:
                extract_m4a(proxy, m4a, self._tool, ctx.deadline_monotonic)
            except ToolExecutionError as error:
                return _failure(
                    error.error_code if error.error_code == "STAGE_TIMEOUT" else "AUDIO_DECODE"
                )

            wavs: list[dict[str, JsonValue]] = []
            for chunk_idx, (offset_ms, requested_ms) in enumerate(wav_chunk_ranges(duration_ms)):
                wav = work_dir / f"audio-{chunk_idx}.wav"
                try:
                    extract_wav(
                        proxy,
                        wav,
                        start_s=offset_ms / 1000,
                        duration_s=requested_ms / 1000,
                        tool=self._tool,
                        deadline_monotonic=ctx.deadline_monotonic,
                    )
                    wav_probe = probe(wav, self._tool, ctx.deadline_monotonic)
                except ToolExecutionError as error:
                    return _failure(
                        error.error_code if error.error_code == "STAGE_TIMEOUT" else "AUDIO_DECODE"
                    )
                except MediaProbeError as error:
                    return _failure(
                        "STAGE_TIMEOUT" if error.error_code == "STAGE_TIMEOUT" else "AUDIO_DECODE"
                    )
                wav_duration = _duration_ms(wav_probe)
                if (
                    wav_duration is None
                    or wav_duration <= 0
                    or wav.stat().st_size >= _MAX_WAV_BYTES
                ):
                    return _failure("AUDIO_DECODE")
                key = f"{prefix}/audio/{chunk_idx}.wav"
                remaining_timeout(ctx.deadline_monotonic)
                ctx.storage.put_file(key, str(wav), "audio/wav")
                wavs.append({"key": key, "offsetMs": offset_ms, "durationMs": wav_duration})

            frame_dir = work_dir / "keyframes"
            try:
                frame_paths = extract_keyframes(
                    proxy, frame_dir, self._tool, ctx.deadline_monotonic
                )
            except ToolExecutionError as error:
                return _failure(
                    error.error_code if error.error_code == "STAGE_TIMEOUT" else "VIDEO_DECODE"
                )
            keyframes: list[dict[str, JsonValue]] = []
            for idx, path in enumerate(frame_paths):
                key = f"{prefix}/keyframes/{idx}.jpg"
                remaining_timeout(ctx.deadline_monotonic)
                ctx.storage.put_file(key, str(path), "image/jpeg")
                keyframes.append({"idx": idx, "ms": idx * 500, "key": key})

            remaining_timeout(ctx.deadline_monotonic)
            ctx.storage.put_file(proxy_key, str(proxy), "video/mp4")
            remaining_timeout(ctx.deadline_monotonic)
            ctx.storage.put_file(m4a_key, str(m4a), "audio/mp4")
            remaining_timeout(ctx.deadline_monotonic)
            ctx.storage.put_bytes(
                index_key, json.dumps(keyframes, separators=(",", ":")).encode(), "application/json"
            )
            width, height, fps, frame_count = metrics
            output: dict[str, JsonValue] = {
                "proxyKey": proxy_key,
                "audioWavKeys": cast(JsonValue, wavs),
                "audioM4aKey": m4a_key,
                "durationMs": duration_ms,
                "width": width,
                "height": height,
                "fps": fps,
                "frameCount": frame_count,
                "keyframeIndexKey": index_key,
                "sha256Verified": True,
            }
            validate_contract("TranscodeOutput", json.dumps(output))
            return {
                "status": "done",
                "output": output,
                "error_code": None,
                "usage": _empty_usage(),
                "cost_usd": 0.0,
                "trace": None,
            }
        except ToolExecutionError as error:
            return _failure(error.error_code)
        except RuntimeError:
            return _failure("INFRA_NETWORK")
        except (OSError, ValueError):
            return _failure("INFRA_EXEC")
        finally:
            shutil.rmtree(work_dir, ignore_errors=True)
