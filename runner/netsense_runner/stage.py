"""Shared, strictly typed stage boundary (SPEC §6.2)."""

from __future__ import annotations

from typing import Literal, Mapping, Protocol, TypedDict

from netsense_runner.json_types import JsonValue

StageKey = Literal[
    "transcode", "transcribe", "plan", "moment", "subject", "track", "place", "check", "render"
]
WorkerType = Literal["agent", "sub_agent", "model", "tool", "rules"]
StageStatus = Literal["done", "failed", "needs_coach", "skipped"]


class Usage(TypedDict):
    samFrames: int
    inputTokens: int
    outputTokens: int
    audioSeconds: int


class StageTrace(TypedDict, total=False):
    toolCalls: int
    framesViewed: list[int]
    whyThisPlayer: str


class StageResult(TypedDict):
    status: StageStatus
    output: Mapping[str, JsonValue] | None
    error_code: str | None
    usage: Usage
    cost_usd: float
    trace: StageTrace | None


class StageWorker(Protocol):
    id: str
    stage: StageKey
    worker_type: WorkerType
    input_contract: str
    output_contract: str

    def run(self, input_value: Mapping[str, JsonValue], ctx: "StageContext") -> StageResult: ...


from netsense_runner.context import StageContext  # noqa: E402  # avoids a Protocol-only cycle
