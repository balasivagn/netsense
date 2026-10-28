"""Injectable non-chat provider boundary; no HTTP client is constructed here."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterator, Mapping, Protocol

from netsense_runner.json_types import JsonValue


class ModelApiTransport(Protocol):
    def post_multipart(
        self, path: str, fields: Mapping[str, str], file_bytes: bytes, filename: str
    ) -> str: ...

    def post_json_stream(self, path: str, payload: Mapping[str, JsonValue]) -> Iterator[str]: ...


@dataclass(frozen=True, slots=True)
class TranscriptionRequest:
    model: str
    keywords: tuple[str, ...]
    language_bias: tuple[str, ...]
    audio: bytes
    filename: str


class ModelApiAdapter:
    """UNTESTED Meta endpoint semantics; only exact transport shapes are unit-tested."""

    def __init__(self, transport: ModelApiTransport) -> None:
        self._transport = transport

    def transcribe(self, request: TranscriptionRequest) -> str:
        payload = {
            "mode": "DIARIZATION",
            "model": request.model,
            "audioEncoding": "WAV",
            "keywords": list(request.keywords),
            "languageBias": list(request.language_bias),
        }
        fields = {"request": __import__("json").dumps(payload)}
        return self._transport.post_multipart(
            "/asr/transcribe", fields, request.audio, request.filename
        )

    def responses_stream(self, model: str, content: list[JsonValue]) -> Iterator[str]:
        payload: dict[str, JsonValue] = {"model": model, "stream": True, "input": content}
        return self._transport.post_json_stream("/v1/responses", payload)
