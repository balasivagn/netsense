"""Small, bounded client for the reviewed job-token worker routes.

This deliberately does not adapt the legacy ``StageContext.WorkerApi`` protocol.
The DAG/context adaptation is a separate slice; callers use these typed methods.
"""

from __future__ import annotations

import json
import math
import socket
import time
from dataclasses import dataclass
from email.message import Message
from typing import IO, Literal, Protocol, TypeVar
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from pydantic import BaseModel, ValidationError

from netsense_runner.contract_validation import validate_contract
from netsense_runner.contracts.CheckOutput import CheckOutput
from netsense_runner.contracts.MomentOutput import MomentOutput
from netsense_runner.contracts.PlaceOutput import PlaceOutput
from netsense_runner.contracts.PlanOutput import PlanOutput
from netsense_runner.contracts.Provenance import Provenance
from netsense_runner.contracts.RenderOutput import RenderOutput
from netsense_runner.contracts.SubjectAnchorOutput import SubjectAnchorOutput
from netsense_runner.contracts.SubjectOutput import SubjectOutput
from netsense_runner.contracts.TrackOutput import TrackOutput
from netsense_runner.contracts.TranscodeOutput import TranscodeOutput
from netsense_runner.contracts.TranscribeOutput import TranscribeOutput
from netsense_runner.json_types import JsonValue

from .worker_wire import (
    DoneRequest,
    FinishStageRequest,
    MarksResponse,
    OkResponse,
    StageKey,
    StartStageRequest,
    StartStageResponse,
    WorkerJobResponse,
)

_MAX_RESPONSE_BYTES = 32_768
_PERSIST_RESPONSE_BYTES = 32_768
_READ_CHUNK_BYTES = 8_192
_HEX64 = set("0123456789abcdef")
_T = TypeVar("_T", bound=BaseModel)
TerminalStageStatus = Literal["done", "failed", "fallback", "skipped", "needs_coach"]
JobDoneStatus = Literal["waiting_for_coach", "failed", "done"]


class WorkerClientError(Exception):
    """A fixed, safe client failure code; never carries transport content."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(
        self,
        request: Request,
        fp: IO[bytes],
        code: int,
        msg: str,
        headers: Message,
        newurl: str,
    ) -> Request | None:
        raise WorkerClientError("REDIRECT_REJECTED")


class _ReadableResponse(Protocol):
    status: int

    def read(self, amount: int = -1) -> bytes: ...


@dataclass(frozen=True)
class ConvexWorkerClient:
    """Thread-safe per-job client. Each call has independent transport state."""

    runtime_site_url: str
    job_token: str
    timeout_s: float = 20.0
    max_response_bytes: int = _MAX_RESPONSE_BYTES

    def __post_init__(self) -> None:
        parsed = urlsplit(self.runtime_site_url)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.netloc
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
            or parsed.path not in {"", "/"}
        ):
            raise ValueError("INVALID_ORIGIN")
        if not math.isfinite(self.timeout_s) or self.timeout_s <= 0:
            raise ValueError("INVALID_TIMEOUT")
        if self.max_response_bytes <= 0:
            raise ValueError("INVALID_RESPONSE_LIMIT")
        object.__setattr__(self, "runtime_site_url", f"{parsed.scheme}://{parsed.netloc}")

    def __repr__(self) -> str:
        return (
            "ConvexWorkerClient("
            f"runtime_site_url={self.runtime_site_url!r}, timeout_s={self.timeout_s!r})"
        )

    def get_job(self) -> WorkerJobResponse:
        response = self._request("GET", "/worker/job", None, WorkerJobResponse)
        if response.config.version != response.job.configVersion:
            raise WorkerClientError("INVALID_RESPONSE")
        try:
            self._validate_contract("PipelineConfig", self._model_json(response.config))
            if response.session.subject is not None:
                self._validate_contract("Subject", self._model_json(response.session.subject))
                if response.session.subject.role != response.session.subjectRole:
                    raise ValueError("INVALID_RESPONSE")
        except (WorkerClientError, ValueError):
            raise WorkerClientError("INVALID_RESPONSE") from None
        return response

    def heartbeat(self) -> None:
        self._ok("/worker/heartbeat", {})

    def start_stage(
        self,
        *,
        stage: StageKey,
        worker_id: str,
        attempt: int,
        idempotency_key: str,
        input_hash: str,
        remark_id: str | None = None,
        prompt_hash: str | None = None,
        candidate: str | None = None,
    ) -> str:
        payload: dict[str, JsonValue] = {
            "stage": stage,
            "workerId": worker_id,
            "attempt": attempt,
            "idempotencyKey": idempotency_key,
            "inputHash": input_hash,
        }
        self._optional(payload, "remarkId", remark_id)
        self._optional(payload, "promptHash", prompt_hash)
        self._optional(payload, "candidate", candidate)
        self._validate_request(StartStageRequest, payload)
        response = self._request("POST", "/worker/stageRuns/start", payload, StartStageResponse)
        return response.stageRunId

    def finish_stage(
        self,
        *,
        stage_run_id: str,
        status: TerminalStageStatus,
        sam_frames: int,
        input_tokens: int,
        output_tokens: int,
        cost_usd: float,
        output_ref: str | None = None,
        error_code: str | None = None,
    ) -> None:
        payload: dict[str, JsonValue] = {
            "stageRunId": stage_run_id,
            "status": status,
            "samFrames": sam_frames,
            "inputTokens": input_tokens,
            "outputTokens": output_tokens,
            "costUsd": cost_usd,
        }
        self._optional(payload, "outputRef", output_ref)
        self._optional(payload, "errorCode", error_code)
        self._validate_request(FinishStageRequest, payload)
        self._ok("/worker/stageRuns/finish", payload)

    def done(self, *, status: JobDoneStatus, error_code: str | None = None) -> None:
        payload: dict[str, JsonValue] = {"status": status}
        self._optional(payload, "errorCode", error_code)
        self._validate_request(DoneRequest, payload)
        self._ok("/worker/done", payload)

    def persist_transcode(self, stage_run_id: str, output: TranscodeOutput) -> None:
        self._persist("transcode", stage_run_id, output, "TranscodeOutput")

    def persist_turns(self, stage_run_id: str, output: TranscribeOutput) -> None:
        self._persist("turns", stage_run_id, output, "TranscribeOutput")

    def persist_plan(self, stage_run_id: str, output: PlanOutput) -> None:
        self._persist("plan", stage_run_id, output, "PlanOutput")

    def persist_moment(self, stage_run_id: str, output: MomentOutput) -> None:
        self._persist("moment", stage_run_id, output, "MomentOutput")

    def persist_target(
        self, stage_run_id: str, output: SubjectAnchorOutput | SubjectOutput
    ) -> None:
        contract = (
            "SubjectAnchorOutput" if isinstance(output, SubjectAnchorOutput) else "SubjectOutput"
        )
        self._persist("target", stage_run_id, output, contract)

    def persist_track(self, stage_run_id: str, output: TrackOutput, *, cache_key: str) -> None:
        if len(cache_key) != 64 or any(char not in _HEX64 for char in cache_key):
            raise WorkerClientError("CONTRACT_INVALID")
        self._persist("track", stage_run_id, output, "TrackOutput", {"cacheKey": cache_key})

    def persist_marks(
        self, stage_run_id: str, output: PlaceOutput, *, provenance: Provenance
    ) -> dict[str, str]:
        provenance_value = self._model_json(provenance)
        self._validate_contract("Provenance", provenance_value)
        payload = self._payload(
            stage_run_id,
            output,
            "PlaceOutput",
            {"provenance": provenance_value},
        )
        response = self._request("POST", "/worker/persist/marks", payload, MarksResponse)
        mapping: dict[str, str] = {}
        for item in response.annotationIds:
            if item.markId in mapping:
                raise WorkerClientError("INVALID_RESPONSE")
            mapping[item.markId] = item.annotationId
        expected = {mark.markId for mark in output.marks}
        if set(mapping) != expected or len(set(mapping.values())) != len(mapping):
            raise WorkerClientError("INVALID_RESPONSE")
        return mapping

    def persist_verdicts(self, stage_run_id: str, output: CheckOutput) -> None:
        self._persist("verdicts", stage_run_id, output, "CheckOutput")

    def persist_render(self, stage_run_id: str, output: RenderOutput) -> None:
        self._persist("render", stage_run_id, output, "RenderOutput")

    def _persist(
        self,
        suffix: str,
        stage_run_id: str,
        output: BaseModel,
        contract: str,
        extra: dict[str, JsonValue] | None = None,
    ) -> None:
        self._ok(f"/worker/persist/{suffix}", self._payload(stage_run_id, output, contract, extra))

    def _payload(
        self,
        stage_run_id: str,
        output: BaseModel,
        contract: str,
        extra: dict[str, JsonValue] | None = None,
    ) -> dict[str, JsonValue]:
        if not isinstance(stage_run_id, str) or not 0 < len(stage_run_id) <= 1024:
            raise WorkerClientError("CONTRACT_INVALID")
        value = self._model_json(output)
        self._validate_contract(contract, value)
        payload: dict[str, JsonValue] = {"stageRunId": stage_run_id, "output": value}
        if extra is not None:
            payload.update(extra)
        return payload

    @staticmethod
    def _validate_contract(contract: str, value: dict[str, JsonValue]) -> None:
        try:
            validate_contract(contract, json.dumps(value, allow_nan=False, separators=(",", ":")))
        except (TypeError, ValueError):
            raise WorkerClientError("CONTRACT_INVALID") from None

    @staticmethod
    def _model_json(model: BaseModel) -> dict[str, JsonValue]:
        try:
            value = _json_value(model.model_dump(mode="python", by_alias=True, warnings=False))
        except (json.JSONDecodeError, ValueError):
            raise WorkerClientError("CONTRACT_INVALID") from None
        if not isinstance(value, dict):
            raise WorkerClientError("CONTRACT_INVALID")
        return value

    @staticmethod
    def _validate_request(model: type[BaseModel], payload: dict[str, JsonValue]) -> None:
        try:
            model.model_validate(payload)
        except ValidationError:
            raise WorkerClientError("CONTRACT_INVALID") from None

    @staticmethod
    def _optional(payload: dict[str, JsonValue], key: str, value: str | None) -> None:
        if value is not None:
            payload[key] = value

    def _ok(self, path: str, payload: dict[str, JsonValue]) -> None:
        self._request("POST", path, payload, OkResponse)

    def _request(
        self, method: str, path: str, payload: dict[str, JsonValue] | None, response_type: type[_T]
    ) -> _T:
        body: bytes | None = None
        if payload is not None:
            try:
                body = json.dumps(payload, allow_nan=False, separators=(",", ":")).encode("utf-8")
            except (TypeError, ValueError):
                raise WorkerClientError("CONTRACT_INVALID") from None
        request = Request(
            f"{self.runtime_site_url}{path}",
            data=body,
            method=method,
            headers={
                "Authorization": f"Bearer {self.job_token}",
                "Accept": "application/json",
                **({"Content-Type": "application/json"} if body is not None else {}),
            },
        )
        deadline = time.monotonic() + self.timeout_s
        try:
            with build_opener(_NoRedirect()).open(request, timeout=self.timeout_s) as raw_result:
                result: _ReadableResponse = raw_result
                if not 200 <= result.status < 300:
                    raise WorkerClientError("HTTP_STATUS")
                raw = self._read_bounded(result, deadline)
        except WorkerClientError:
            raise
        except HTTPError:
            raise WorkerClientError("HTTP_STATUS") from None
        except (URLError, OSError, socket.timeout, TimeoutError):
            raise WorkerClientError("TRANSPORT_FAILED") from None
        try:
            decoded = raw.decode("utf-8")
            data = _json_value(json.loads(decoded))
            return response_type.model_validate(data)
        except (UnicodeDecodeError, json.JSONDecodeError, ValidationError, ValueError):
            raise WorkerClientError("INVALID_RESPONSE") from None

    def _read_bounded(self, result: _ReadableResponse, deadline: float) -> bytes:
        chunks: list[bytes] = []
        total = 0
        while True:
            if time.monotonic() >= deadline:
                raise WorkerClientError("TIMEOUT")
            chunk = result.read(_READ_CHUNK_BYTES)
            if not chunk:
                return b"".join(chunks)
            total += len(chunk)
            if total > self.max_response_bytes or total > _PERSIST_RESPONSE_BYTES:
                raise WorkerClientError("RESPONSE_TOO_LARGE")
            chunks.append(chunk)


def _json_value(value: object) -> JsonValue:
    """Turn stdlib JSON output into the narrow recursive boundary type."""
    if value is None or isinstance(value, (str, int, bool)):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("NONFINITE")
        return value
    if isinstance(value, list):
        return [_json_value(item) for item in value]
    if isinstance(value, dict):
        result: dict[str, JsonValue] = {}
        for key, item in value.items():
            if not isinstance(key, str):
                raise ValueError("INVALID_KEY")
            result[key] = _json_value(item)
        return result
    raise ValueError("INVALID_JSON_VALUE")
