"""Stage context protocols; concrete HTTP clients are deliberately a later lane."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from netsense_runner.budget import Budget
from netsense_runner.registry import ProviderRegistry


class WorkerStorage(Protocol):
    def get_url(self, key: str) -> str: ...

    def put_bytes(self, key: str, data: bytes, content_type: str) -> None: ...

    def put_file(self, key: str, path: str, content_type: str) -> None: ...


class WorkerApi(Protocol):
    """Minimal documented worker API; T1.10 owns its exact HTTP wire format."""

    def persist_stage_output(self, stage_run_id: str, output_ref: str) -> None: ...

    def report_stage_usage(self, stage_run_id: str, cost_usd: float) -> None: ...


class StructuredLogger(Protocol):
    """Implementations must scrub URLs, credentials and transcript/raw-response text."""

    def event(self, name: str, **fields: str | int | float | bool | None) -> None: ...


@dataclass(frozen=True, slots=True)
class StageContext:
    job_id: str
    session_id: str
    config_version: int
    stage_run_id: str
    remark_id: str | None
    attempt: int
    deadline_monotonic: float
    budget: Budget
    storage: WorkerStorage
    convex: WorkerApi
    providers: ProviderRegistry
    log: StructuredLogger
