"""Typed DAG API boundary: only the reviewed worker routes, no generic writes."""

from __future__ import annotations

from typing import Literal, Protocol

from netsense_runner.clients.worker_wire import (
    StageKey,
    WorkerJobResponse,
)
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

TerminalStageStatus = Literal["done", "failed", "fallback", "skipped", "needs_coach"]
JobDoneStatus = Literal["waiting_for_coach", "failed", "done"]


class WorkerClient(Protocol):
    def get_job(self) -> WorkerJobResponse: ...

    def heartbeat(self) -> None: ...

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
    ) -> str: ...

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
    ) -> None: ...

    def done(self, *, status: JobDoneStatus, error_code: str | None = None) -> None: ...

    def persist_transcode(self, stage_run_id: str, output: TranscodeOutput) -> None: ...

    def persist_turns(self, stage_run_id: str, output: TranscribeOutput) -> None: ...

    def persist_plan(self, stage_run_id: str, output: PlanOutput) -> None: ...

    def persist_moment(self, stage_run_id: str, output: MomentOutput) -> None: ...

    def persist_target(
        self, stage_run_id: str, output: SubjectAnchorOutput | SubjectOutput
    ) -> None: ...

    def persist_track(self, stage_run_id: str, output: TrackOutput, *, cache_key: str) -> None: ...

    def persist_marks(
        self, stage_run_id: str, output: PlaceOutput, *, provenance: Provenance
    ) -> dict[str, str]: ...

    def persist_verdicts(self, stage_run_id: str, output: CheckOutput) -> None: ...

    def persist_render(self, stage_run_id: str, output: RenderOutput) -> None: ...
