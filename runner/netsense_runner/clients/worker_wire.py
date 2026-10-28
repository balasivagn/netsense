"""Closed Python projections for the reviewed worker HTTP wire."""

from __future__ import annotations

from typing import Annotated, Literal, Self

from pydantic import Field, StrictBool, model_validator

from netsense_runner.contract_base import ContractModel
from netsense_runner.contracts.ErrorCode import ErrorCode
from netsense_runner.contracts.PipelineConfig import PipelineConfig
from netsense_runner.contracts.Subject import Subject
from netsense_runner.contracts.SubjectAnchorOutput import AnchorBox

StageKey = Literal[
    "transcode", "transcribe", "plan", "moment", "subject", "track", "place", "check", "render"
]


Identifier = Annotated[str, Field(min_length=1, max_length=1024)]
Hash = Annotated[str, Field(pattern="^[a-f0-9]{64}$")]
Counter = Annotated[int, Field(ge=0, le=9007199254740991)]


class JobWire(ContractModel):
    id: Identifier
    sessionId: Identifier
    kind: Literal["pipeline", "subject_retrack", "remark_retrack", "stage_retry", "finalize"]
    configVersion: int = Field(ge=1)
    attempt: int = Field(ge=0)
    maxAttempts: int = Field(ge=1)
    status: Literal["queued", "running", "done", "failed", "waiting_for_coach", "cancelled"]
    leaseOwner: str | None
    leaseUntil: Counter | None
    heartbeatAt: Counter | None
    stage: StageKey | None
    remarkId: str | None


class SubjectAnchorWire(ContractModel):
    box: AnchorBox
    frameMs: int = Field(ge=0)
    referenceCropKey: str


class SessionWire(ContractModel):
    subject: Subject | None
    subjectAnchor: SubjectAnchorWire | None
    renderMode: Literal["video", "stills"]
    durationMs: Counter | None
    studentLabel: Annotated[str, Field(min_length=1)]
    subjectRole: Literal["batter", "bowler", "other"]


class UploadWire(ContractModel):
    uploadId: Identifier
    sourceKey: Identifier
    declaredBytes: int = Field(gt=0)
    declaredSha256: Hash
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
    stageRunId: Identifier
    idempotencyKey: Hash
    stage: StageKey
    remarkId: str | None
    inputHash: Hash
    outputRef: str


class InputsWire(UploadWire):
    transcriptTurns: list[TranscriptTurnWire]
    remarks: list[RemarkWire]
    completedStageRuns: list[CompletedStageRunWire]


class WorkerJobResponse(ContractModel):
    job: JobWire
    config: PipelineConfig
    session: SessionWire
    inputs: InputsWire


class OkResponse(ContractModel):
    ok: StrictBool

    @model_validator(mode="after")
    def successful(self) -> Self:
        if self.ok is not True:
            raise ValueError("INVALID_RESPONSE")
        return self


class StartStageResponse(ContractModel):
    stageRunId: Identifier


class MarksResponse(OkResponse):
    annotationIds: list["AnnotationId"]


class AnnotationId(ContractModel):
    markId: Identifier
    annotationId: Identifier


class StartStageRequest(ContractModel):
    stage: StageKey
    workerId: Identifier
    attempt: int = Field(ge=1, le=9007199254740991)
    idempotencyKey: Hash
    inputHash: Hash
    remarkId: Identifier | None = None
    promptHash: Hash | None = None
    candidate: Identifier | None = None


class FinishStageRequest(ContractModel):
    stageRunId: Identifier
    status: Literal["done", "failed", "fallback", "skipped", "needs_coach"]
    samFrames: Counter
    inputTokens: Counter
    outputTokens: Counter
    costUsd: float = Field(ge=0, allow_inf_nan=False)
    outputRef: Identifier | None = None
    errorCode: ErrorCode | None = None

    @model_validator(mode="after")
    def completed_output(self) -> Self:
        if self.status == "done" and self.outputRef is None:
            raise ValueError("CONTRACT_INVALID")
        return self


class DoneRequest(ContractModel):
    status: Literal["waiting_for_coach", "failed", "done"]
    errorCode: ErrorCode | None = None
