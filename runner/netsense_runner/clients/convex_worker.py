"""Small, bounded client for the reviewed job-token worker routes.

This deliberately does not adapt the legacy ``StageContext.WorkerApi`` protocol.
The DAG/context adaptation is a separate slice; callers use these typed methods.
"""

from __future__ import annotations

import json
import math
import re
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, TypeVar
from urllib.parse import urlsplit

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

_MAX_RESPONSE_BYTES = 1_048_576
_HEX64 = set("0123456789abcdef")
_T = TypeVar("_T", bound=BaseModel)
TerminalStageStatus = Literal["done", "failed", "fallback", "skipped", "needs_coach"]
JobDoneStatus = Literal["waiting_for_coach", "failed", "done"]


class WorkerClientError(Exception):
    """A fixed, safe client failure code; never carries transport content."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class ConvexWorkerClient:
    """Thread-safe per-job client. Each call has independent transport state."""

    runtime_site_url: str
    job_token: str
    timeout_s: float = 20.0
    max_response_bytes: int = _MAX_RESPONSE_BYTES

    def __post_init__(self) -> None:
        try:
            if not isinstance(self.runtime_site_url, str) or any(
                char.isspace() or ord(char) < 33 or ord(char) > 126
                for char in self.runtime_site_url
            ):
                raise ValueError
            parsed = urlsplit(self.runtime_site_url)
            if (
                parsed.scheme not in {"http", "https"}
                or not parsed.hostname
                or not re.fullmatch(
                    r"(?:\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9][a-zA-Z0-9.-]*)(?::[0-9]+)?",
                    parsed.netloc,
                )
                or parsed.username is not None
                or parsed.password is not None
                or parsed.query or parsed.fragment
                or "?" in self.runtime_site_url or "#" in self.runtime_site_url
                or parsed.path not in {"", "/"}
                or "\\" in parsed.netloc
                or parsed.netloc.endswith(":")
                or (parsed.port is not None and not 0 < parsed.port <= 65535)
            ):
                raise ValueError
        except (ValueError, TypeError):
            raise ValueError("INVALID_ORIGIN") from None
        try:
            if isinstance(self.timeout_s, bool) or not isinstance(self.timeout_s, (int, float)):
                raise ValueError
            timeout = float(self.timeout_s)
            if not math.isfinite(timeout) or timeout <= 0:
                raise ValueError
        except (ValueError, TypeError, OverflowError):
            raise ValueError("INVALID_TIMEOUT") from None
        object.__setattr__(self, "timeout_s", timeout)
        if (
            type(self.max_response_bytes) is not int
            or not 0 < self.max_response_bytes <= _MAX_RESPONSE_BYTES
        ):
            raise ValueError("INVALID_RESPONSE_LIMIT")
        if (
            not isinstance(self.job_token, str) or not self.job_token
            or any(ord(char) < 33 or ord(char) > 126 for char in self.job_token)
        ):
            raise ValueError("INVALID_TOKEN")
        object.__setattr__(self, "runtime_site_url", f"{parsed.scheme}://{parsed.netloc}")

    def __repr__(self) -> str:
        return "ConvexWorkerClient()"

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
        if (
            not isinstance(cache_key, str) or len(cache_key) != 64
            or any(char not in _HEX64 for char in cache_key)
        ):
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
        except (TypeError, ValueError, RecursionError):
            raise WorkerClientError("CONTRACT_INVALID") from None

    @staticmethod
    def _model_json(model: BaseModel) -> dict[str, JsonValue]:
        if not isinstance(model, BaseModel):
            raise WorkerClientError("CONTRACT_INVALID")
        try:
            value = _json_value(model.model_dump(mode="python", by_alias=True, warnings=False))
        except (TypeError, ValueError, RecursionError):
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
            except (TypeError, ValueError, RecursionError):
                raise WorkerClientError("CONTRACT_INVALID") from None
        request_limit = 1_048_576 if path.startswith("/worker/persist/") else 32_768
        if body is not None and len(body) > request_limit:
            raise WorkerClientError("REQUEST_TOO_LARGE")
        deadline = time.monotonic() + self.timeout_s
        process: subprocess.Popen[bytes] | None = None
        try:
            # Child owns all resolver/socket state. No background executor survives
            # cancellation, and no shared lock can hold up a concurrent heartbeat.
            envelope = json.dumps([
                self.runtime_site_url, self.job_token, method, path,
                body.decode("utf-8") if body is not None else None,
                self.timeout_s, self.max_response_bytes,
            ]).encode("utf-8")
            process = subprocess.Popen(
                [sys.executable, str(Path(__file__).with_name("_http_transport.py"))],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            )
            remaining = max(0.0, deadline - time.monotonic())
            wire, _ = process.communicate(envelope, timeout=remaining)
            if time.monotonic() >= deadline:
                raise WorkerClientError("TIMEOUT")
            code, separator, raw = wire.partition(b"\n")
            if process.returncode != 0 or not separator:
                raise WorkerClientError("TRANSPORT_FAILED")
            if code != b"OK":
                safe_codes = {
                    b"TIMEOUT", b"TRANSPORT_FAILED", b"HTTP_STATUS",
                    b"REDIRECT_REJECTED", b"RESPONSE_TOO_LARGE",
                }
                raise WorkerClientError(
                    code.decode("ascii") if code in safe_codes else "TRANSPORT_FAILED"
                )
        except subprocess.TimeoutExpired:
            raise WorkerClientError("TIMEOUT") from None
        except (OSError, ValueError, TypeError):
            raise WorkerClientError("TRANSPORT_FAILED") from None
        finally:
            if process is not None:
                if process.poll() is None:
                    process.kill()
                process.communicate()
        try:
            decoded = raw.decode("utf-8")
            data = _json_value(json.loads(decoded))
            return response_type.model_validate(data)
        except (UnicodeDecodeError, ValueError, RecursionError):
            raise WorkerClientError("INVALID_RESPONSE") from None


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
