"""Closed Python projections for the reviewed worker HTTP wire."""

from __future__ import annotations

from typing import Literal

from pydantic import Field

from netsense_runner.contract_base import ContractModel
from netsense_runner.contracts.PipelineConfig import PipelineConfig
from netsense_runner.contracts.Subject import Subject

StageKey = Literal[
    "transcode", "transcribe", "plan", "moment", "subject", "track", "place", "check", "render"
]


class JobWire(ContractModel):
    id: str
    sessionId: str
    kind: Literal["pipeline", "subject_retrack", "remark_retrack", "stage_retry", "finalize"]
    configVersion: int = Field(ge=1)
    attempt: int = Field(ge=0)
    maxAttempts: int = Field(ge=1)
    status: Literal["queued", "running", "done", "failed", "waiting_for_coach", "cancelled"]
    leaseOwner: str | None
    leaseUntil: int | None
    heartbeatAt: int | None
    stage: StageKey | None
    remarkId: str | None


class SubjectAnchorWire(ContractModel):
    box: dict[str, float]
    frameMs: int = Field(ge=0)
    referenceCropKey: str


class SessionWire(ContractModel):
    subject: Subject | None
    subjectAnchor: SubjectAnchorWire | None
    renderMode: Literal["video", "stills"]
    durationMs: int | None
    studentLabel: str
    subjectRole: Literal["batter", "bowler", "other"] | None


class UploadWire(ContractModel):
    uploadId: str
    sourceKey: str
    declaredBytes: int = Field(ge=0)
    declaredSha256: str
    mimeType: str


class TranscriptTurnWire(ContractModel):
    turnId: str
    startMs: int = Field(ge=0)
    endMs: int = Field(ge=0)
    speaker: str
    text: str
    correctedText: str | None


class RemarkWire(ContractModel):
    remarkId: str
    turnIds: list[str]
    source: Literal["voice", "typed"]
    aboutSubject: Literal["yes", "no", "unclear", "general"]
    kind: Literal["feedback", "instruction", "praise", "other"]
    atMs: int = Field(ge=0)
    mode: Literal["tracked", "still_frame", "note_only"]
    momentStartMs: int | None
    momentEndMs: int | None
    keyframeMs: int | None
    momentWhy: str | None
    status: Literal["pending", "ok", "player_missing", "needs_coach"]
    includeInShare: bool


class CompletedStageRunWire(ContractModel):
    jobId: str
    stageRunId: str
    idempotencyKey: str
    stage: StageKey
    remarkId: str | None
    inputHash: str
    outputRef: str


class InputsWire(ContractModel):
    upload: UploadWire
    transcriptTurns: list[TranscriptTurnWire]
    remarks: list[RemarkWire]
    completedStageRuns: list[CompletedStageRunWire]


class WorkerJobResponse(ContractModel):
    job: JobWire
    config: PipelineConfig
    session: SessionWire
    inputs: InputsWire


class OkResponse(ContractModel):
    ok: Literal[True]


class StartStageResponse(ContractModel):
    stageRunId: str


class MarksResponse(ContractModel):
    ok: Literal[True]
    annotationIds: list["AnnotationId"]


class AnnotationId(ContractModel):
    markId: str
    annotationId: str
