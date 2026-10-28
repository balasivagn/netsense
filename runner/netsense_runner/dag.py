"""Injectable pinned-config runner. Workers cooperate with deadlines; no thread killing."""

from __future__ import annotations

import hashlib
import json
import math
import threading
import time
from collections.abc import Callable, Mapping
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Literal, TypeVar

from pydantic import BaseModel

from netsense_runner import input_builders as build
from netsense_runner.artifacts import Artifacts, canonical, digest, model_value, scoped, validated
from netsense_runner.budget import Budget, BudgetExceeded
from netsense_runner.clients.worker_wire import WorkerJobResponse
from netsense_runner.context import StageContext, StructuredLogger, WorkerStorage
from netsense_runner.contract_validation import validate_contract
from netsense_runner.contracts.CheckOutput import CheckOutput
from netsense_runner.contracts.MomentOutput import MomentOutput
from netsense_runner.contracts.PlaceOutput import PlaceOutput
from netsense_runner.contracts.PlanOutput import PlanOutput, Remark
from netsense_runner.contracts.Provenance import Provenance
from netsense_runner.contracts.RenderOutput import RenderOutput
from netsense_runner.contracts.SubjectAnchorOutput import SubjectAnchorOutput
from netsense_runner.contracts.SubjectOutput import SubjectOutput
from netsense_runner.contracts.TrackFile import TrackFile
from netsense_runner.contracts.TrackOutput import TrackOutput
from netsense_runner.contracts.TranscodeOutput import TranscodeOutput
from netsense_runner.contracts.TranscribeOutput import TranscribeOutput
from netsense_runner.json_types import JsonValue
from netsense_runner.persistence import WorkerClient
from netsense_runner.registry import ProviderRegistry
from netsense_runner.rules.stills_routing import TrackedRemark, should_route_to_stills
from netsense_runner.stage import StageKey, StageResult, StageWorker

T = TypeVar("T", bound=BaseModel)
WorkerFactory = Callable[[int | None], StageWorker]


class DagFailure(Exception):
    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


@dataclass(frozen=True)
class Completed:
    output: BaseModel
    run_id: str
    worker_id: str
    model: str | None
    annotations: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class Outcome:
    status: Literal["waiting_for_coach", "failed", "done"]
    error_code: str | None
    branch_errors: Mapping[str, str]


def identity(
    job_id: str,
    stage: StageKey,
    remark_id: str | None,
    worker_id: str,
    value: Mapping[str, JsonValue],
) -> tuple[str, str]:
    input_hash = digest(value)
    # JSON strings and JSON null delimit each component unambiguously, even with '|'.
    raw = b"|".join(canonical(x) for x in (job_id, stage, remark_id, worker_id, input_hash))
    return input_hash, hashlib.sha256(raw).hexdigest()


class Runner:
    def __init__(
        self,
        *,
        client: WorkerClient,
        artifacts: Artifacts,
        storage: WorkerStorage,
        budget: Budget,
        providers: ProviderRegistry,
        workers: Mapping[tuple[str, str], WorkerFactory],
        log: StructuredLogger,
        cleanup: Callable[[], None],
        clock: Callable[[], float] = time.monotonic,
        wait: Callable[[float], None] = time.sleep,
        heartbeat_interval: float = 20.0,
        cancelled: threading.Event | None = None,
    ) -> None:
        if not math.isfinite(heartbeat_interval) or heartbeat_interval <= 0:
            raise ValueError("CONTRACT_INVALID")
        self.client, self.artifacts, self.storage = client, artifacts, storage
        self.budget, self.providers, self.log = budget, providers, log
        self.workers = dict(workers)
        self.cleanup, self.clock, self.wait = cleanup, clock, wait
        self.heartbeat_interval = heartbeat_interval
        self.cancelled = cancelled or threading.Event()
        self.heartbeat_stopped = threading.Event()
        self._stop = threading.Event()
        self._heartbeat_failed = threading.Event()
        self._job: WorkerJobResponse | None = None
        self._deadline = float("inf")
        self._budget_failure: str | None = None
        self._budget_lock = threading.Lock()

    def _heartbeat(self) -> None:
        try:
            while not self._stop.wait(self.heartbeat_interval):
                try:
                    self.client.heartbeat()
                except Exception:
                    self._heartbeat_failed.set()
                    return
        finally:
            self.heartbeat_stopped.set()

    def _alive(self) -> None:
        with self._budget_lock:
            if self._budget_failure is not None:
                raise DagFailure(self._budget_failure)
        if self._heartbeat_failed.is_set() or self.cancelled.is_set():
            raise DagFailure("INFRA_NETWORK")
        if self.clock() >= self._deadline:
            raise DagFailure("STAGE_TIMEOUT")

    @property
    def job(self) -> WorkerJobResponse:
        if self._job is None:
            raise DagFailure("INFRA_EXEC")
        return self._job

    def run(self) -> Outcome:
        status: Literal["waiting_for_coach", "failed", "done"] = "failed"
        error: str | None = "INFRA_EXEC"
        errors: dict[str, str] = {}
        self._stop.clear()
        self._heartbeat_failed.clear()
        self.heartbeat_stopped.clear()
        self._budget_failure = None
        heartbeat = threading.Thread(target=self._heartbeat, name="runner-heartbeat")
        heartbeat.start()
        try:
            self._job = self.client.get_job()
            job = self.job
            validated("PipelineConfig", model_value(job.config))
            if job.job.sessionId != self.artifacts.session_id or job.job.status != "running":
                raise DagFailure("CONTRACT_INVALID")
            minutes = (
                math.ceil(job.session.durationMs / 60000)
                if job.session.durationMs is not None
                else job.config.limits.maxVideoMinutes
            )
            self._deadline = self.clock() + min(
                job.config.limits.sandboxTimeoutCapS, 600 + 180 * minutes
            )
            if job.job.kind not in {"pipeline", "subject_retrack"}:
                raise DagFailure("CONTRACT_INVALID")
            if job.session.subject is None:
                raise DagFailure("SUBJECT_NEEDED")
            errors = self._pipeline()
            status, error = "waiting_for_coach", None
            if self._budget_failure is not None:
                status, error = "failed", self._budget_failure
            tracked = [TrackedRemark("tracked", code) for code in errors.values()]
            tracked += [TrackedRemark("tracked", None)] * self._successful_branches
            if error is None and should_route_to_stills(tracked, job.config.params.stillsThreshold):
                error = "SEG_NO_TRACK"
        except DagFailure as failure:
            error = failure.code
            if error in {"SUBJECT_NEEDED", "NO_SPEECH"}:
                status = "waiting_for_coach"
        except Exception:
            error = "INFRA_EXEC"
        finally:
            self._stop.set()
            heartbeat.join()  # HTTP implementation must bound its own I/O.
            try:
                self.client.done(status=status, error_code=error)
            except Exception:
                status, error = "failed", "INFRA_NETWORK"
            finally:
                try:
                    self.cleanup()  # Owned resources only; always after workers have returned.
                except Exception:
                    status, error = "failed", "INFRA_EXEC"
        return Outcome(status, error, errors)

    def _resume(
        self,
        stage: StageKey,
        contract: str,
        remark: str | None,
        input_hash: str,
        key: str,
        expected: type[T],
    ) -> Completed | None:
        for run in reversed(self.job.inputs.completedStageRuns):
            same = run.jobId == self.job.job.id
            reusable = self.job.job.kind == "subject_retrack" and stage in {
                "transcode",
                "transcribe",
                "plan",
                "moment",
            }
            if run.stage != stage or run.remarkId != remark or not (same or reusable):
                continue
            if same and (run.inputHash != input_hash or run.idempotencyKey != key):
                continue
            # Approved retrack reuses subject-independent plan/moments under the same
            # config, even when the new tap changes the role label. Source identity
            # and audio must still match. No prior downstream subject data is reused.
            if not same and stage in {"transcode", "transcribe"} and run.inputHash != input_hash:
                continue
            try:
                output = self.artifacts.output(run.outputRef, contract)
                if not isinstance(output, expected):
                    raise ValueError("CONTRACT_INVALID")
                self._dependencies(output)
                metadata = json.loads(self.artifacts.read(run.outputRef + ".receipt"))
                worker_id, model = metadata["workerId"], metadata["model"]
                annotations = metadata["annotations"]
                pinned = next(s for s in self.job.config.stages if s.stage == stage)
                if (
                    worker_id != pinned.workerId
                    or model != pinned.model
                    or metadata["configVersion"] != self.job.config.version
                    or metadata["jobId"] != run.jobId
                    or metadata["stageRunId"] != run.stageRunId
                    or metadata["stage"] != stage
                    or metadata["remarkId"] != remark
                    or metadata["idempotencyKey"] != run.idempotencyKey
                    or metadata["inputHash"] != run.inputHash
                ):
                    raise ValueError("CONTRACT_INVALID")
                if not isinstance(annotations, dict) or any(
                    not isinstance(k, str) or not isinstance(v, str) for k, v in annotations.items()
                ):
                    raise ValueError("CONTRACT_INVALID")
                if isinstance(output, PlaceOutput) and set(annotations) != {
                    m.markId for m in output.marks
                }:
                    raise ValueError("CONTRACT_INVALID")
                return Completed(output, run.stageRunId, worker_id, model, annotations)
            except (OSError, ValueError, KeyError, TypeError):
                if same:
                    raise DagFailure("CONTRACT_INVALID") from None
                continue
        return None

    def _dependencies(self, output: BaseModel) -> None:
        if isinstance(output, TranscodeOutput):
            for key in [
                output.proxyKey,
                output.audioM4aKey,
                output.keyframeIndexKey,
                *(item.key for item in output.audioWavKeys),
            ]:
                self.artifacts.read(key)
            self._frames(output)
        elif isinstance(output, SubjectAnchorOutput):
            self.artifacts.read(output.referenceCropKey)
        elif isinstance(output, TrackOutput):
            self.artifacts.output(output.fileRef, "TrackFile")
            if output.maskRef:
                self.artifacts.read(output.maskRef)
        elif isinstance(output, RenderOutput):
            for key in (
                ([output.fileRef] if output.fileRef else [])
                + [x.key for x in output.stillRefs]
                + [x.key for x in output.segmentRefs]
            ):
                self.artifacts.read(key)

    def _execute(
        self,
        stage: StageKey,
        value: dict[str, JsonValue],
        expected: type[T],
        *,
        remark: str | None = None,
        number: int | None = None,
        upstream: Mapping[str, Completed] | None = None,
        transform: Callable[[T], T] | None = None,
    ) -> Completed:
        pinned = next(s for s in self.job.config.stages if s.stage == stage)
        contract = (
            "SubjectAnchorInput"
            if stage == "subject" and remark is None
            else (expected.__name__.removesuffix("Output") + "Input")
        )
        if not pinned.enabled or (
            pinned.fallbackWorker is not None
            and (stage, pinned.fallbackWorker) != ("render", "live_overlay")
        ):
            raise DagFailure("CONTRACT_INVALID")
        try:
            worker = self.workers[(pinned.workerId, contract)](number)
        except (KeyError, ValueError):
            raise DagFailure("CONTRACT_INVALID") from None
        if (
            worker.id != pinned.workerId
            or worker.stage != stage
            or worker.worker_type != pinned.workerType
            or worker.input_contract != contract
            or worker.output_contract != expected.__name__
        ):
            raise DagFailure("CONTRACT_INVALID")
        input_hash, key = identity(self.job.job.id, stage, remark, worker.id, value)
        resumed = self._resume(stage, worker.output_contract, remark, input_hash, key, expected)
        if resumed is not None:
            return resumed
        if self.job.job.kind == "subject_retrack" and stage in {"transcode", "transcribe", "plan"}:
            raise DagFailure("CONTRACT_INVALID")
        for attempt in range(1, pinned.retry + 2):
            self._alive()
            run_id = self.client.start_stage(
                stage=stage,
                worker_id=worker.id,
                attempt=attempt,
                idempotency_key=key,
                input_hash=input_hash,
                remark_id=remark,
            )
            result: StageResult | None = None
            output_ref: str | None = None
            error: str | None = None
            status: Literal["done", "failed", "skipped", "needs_coach"] = "failed"
            annotations: dict[str, str] = {}
            deadline = min(self._deadline, self.clock() + pinned.timeoutMs / 1000)
            try:
                validated(contract, value)
                self._alive()
                ctx = StageContext(
                    self.job.job.id,
                    self.job.job.sessionId,
                    self.job.config.version,
                    run_id,
                    remark,
                    attempt,
                    deadline,
                    self.budget,
                    self.storage,
                    self.client,
                    self.providers,
                    self.log,
                )
                result = worker.run(value, ctx)
                self._validate_result(result)
                validated(
                    "StageRun",
                    {
                        "jobId": self.job.job.id,
                        "sessionId": self.job.job.sessionId,
                        "stage": stage,
                        "remarkId": remark,
                        "workerId": worker.id,
                        "workerType": worker.worker_type,
                        "provider": pinned.provider,
                        "modelVersion": pinned.model,
                        "promptHash": None,
                        "candidate": None,
                        "attempt": attempt,
                        "idempotencyKey": key,
                        "status": result["status"],
                        "errorCode": result["error_code"],
                        "errorDetail": None,
                        "inputHash": input_hash,
                        "outputRef": None,
                        "startedAt": None,
                        "endedAt": None,
                        "latencyMs": None,
                        "samFrames": result["usage"]["samFrames"],
                        "inputTokens": result["usage"]["inputTokens"],
                        "outputTokens": result["usage"]["outputTokens"],
                        "costUsd": result["cost_usd"],
                    },
                )
                self._alive()
                if self.clock() >= deadline:
                    raise DagFailure("STAGE_TIMEOUT")
                status, error = result["status"], result["error_code"]
                if result["output"] is not None and status in {"done", "needs_coach"}:
                    parsed = validated(worker.output_contract, result["output"])
                    if not isinstance(parsed, expected):
                        raise DagFailure("CONTRACT_INVALID")
                    output = transform(parsed) if transform else parsed
                    validated(worker.output_contract, model_value(output))
                    self._dependencies(output)
                    annotations = self._persist(run_id, output, value, upstream or {}, pinned.model)
                    output_ref = self.artifacts.save(
                        self.job.job.id, run_id, worker.output_contract, model_value(output)
                    )
                    self.artifacts.store.put_new(
                        output_ref + ".receipt",
                        canonical(
                            {
                                "workerId": worker.id,
                                "model": pinned.model,
                                "annotations": annotations,
                                "configVersion": self.job.config.version,
                                "jobId": self.job.job.id,
                                "stageRunId": run_id,
                                "stage": stage,
                                "remarkId": remark,
                                "idempotencyKey": key,
                                "inputHash": input_hash,
                            }
                        ),
                        "application/json",
                    )
                elif status == "done":
                    raise DagFailure("CONTRACT_INVALID")
            except BudgetExceeded as failure:
                with self._budget_lock:
                    self._budget_failure = failure.error_code
                status, error = "failed", failure.error_code
            except DagFailure as failure:
                status, error = "failed", failure.code
            except (ValueError, KeyError, TypeError):
                status, error = "failed", "CONTRACT_INVALID"
            except Exception:
                status, error = "failed", "INFRA_EXEC"
            usage = (
                result["usage"]
                if result is not None
                else {"samFrames": 0, "inputTokens": 0, "outputTokens": 0, "audioSeconds": 0}
            )
            # A malformed result never reaches the wire as malformed usage.
            try:
                if result is not None:
                    self._validate_result(result)
            except (ValueError, TypeError, KeyError):
                usage = {"samFrames": 0, "inputTokens": 0, "outputTokens": 0, "audioSeconds": 0}
                result = None
            self.client.finish_stage(
                stage_run_id=run_id,
                status=status,
                sam_frames=usage["samFrames"],
                input_tokens=usage["inputTokens"],
                output_tokens=usage["outputTokens"],
                cost_usd=result["cost_usd"] if result else 0,
                output_ref=output_ref,
                error_code=error,
            )
            if status == "done" or (status == "needs_coach" and output_ref is not None):
                return Completed(output, run_id, worker.id, pinned.model, annotations)
            if (
                status != "failed"
                or attempt > pinned.retry
                or error
                in {
                    "SEG_BAD_INPUT",
                    "AUDIO_DECODE",
                    "BUDGET_SAM_FRAMES",
                    "BUDGET_TOKENS",
                    "BUDGET_DAILY",
                    "SUBJECT_NEEDED",
                }
            ):
                raise DagFailure(error or "CONTRACT_INVALID")
            self.wait(2.0 if attempt == 1 else 8.0)
        raise DagFailure("INFRA_EXEC")

    @staticmethod
    def _validate_result(result: StageResult) -> None:
        if set(result) != {"status", "output", "error_code", "usage", "cost_usd", "trace"}:
            raise ValueError("CONTRACT_INVALID")
        if result["status"] not in {"done", "failed", "needs_coach", "skipped"}:
            raise ValueError("CONTRACT_INVALID")
        if result["error_code"] is not None:
            validate_contract("ErrorCode", canonical(result["error_code"]).decode())
        if (result["status"] == "done" and result["error_code"] is not None) or (
            result["status"] not in {"done", "skipped"} and result["error_code"] is None
        ):
            raise ValueError("CONTRACT_INVALID")
        usage = result["usage"]
        if set(usage) != {"samFrames", "inputTokens", "outputTokens", "audioSeconds"}:
            raise ValueError("CONTRACT_INVALID")
        if any(type(x) is not int or x < 0 or x > 9007199254740991 for x in usage.values()):
            raise ValueError("CONTRACT_INVALID")
        if (
            isinstance(result["cost_usd"], bool)
            or not math.isfinite(result["cost_usd"])
            or result["cost_usd"] < 0
        ):
            raise ValueError("CONTRACT_INVALID")
        canonical(result)  # Finite trace/output numbers, no unserializable objects.

    def _persist(
        self,
        run: str,
        output: BaseModel,
        value: dict[str, JsonValue],
        upstream: Mapping[str, Completed],
        model: str | None,
    ) -> dict[str, str]:
        api = self.client
        if isinstance(output, TranscodeOutput):
            api.persist_transcode(run, output)
        elif isinstance(output, TranscribeOutput):
            api.persist_turns(run, output)
        elif isinstance(output, PlanOutput):
            api.persist_plan(run, output)
        elif isinstance(output, MomentOutput):
            api.persist_moment(run, output)
        elif isinstance(output, (SubjectOutput, SubjectAnchorOutput)):
            api.persist_target(run, output)
        elif isinstance(output, TrackOutput):
            api.persist_track(run, output, cache_key=build.cache_key(value))
        elif isinstance(output, PlaceOutput):
            stage = next(s for s in self.job.config.stages if s.stage == "place")
            provenance = Provenance.model_validate(
                {
                    "configVersion": self.job.config.version,
                    "stageRunIds": {**{s: c.run_id for s, c in upstream.items()}, "place": run},
                    "workers": {
                        **{s: c.worker_id for s, c in upstream.items()},
                        "place": stage.workerId,
                    },
                    "modelVersions": {
                        **{s: c.model for s, c in upstream.items() if c.model is not None},
                        **({"place": model} if model else {}),
                    },
                    "placedBy": "ai",
                    "candidate": None,
                }
            )
            validated("Provenance", model_value(provenance))
            return api.persist_marks(run, output, provenance=provenance)
        elif isinstance(output, CheckOutput):
            api.persist_verdicts(run, output)
        elif isinstance(output, RenderOutput):
            api.persist_render(run, output)
        else:
            raise DagFailure("CONTRACT_INVALID")
        return {}

    def _frames(self, media: TranscodeOutput) -> list[dict[str, JsonValue]]:
        frames = json.loads(self.artifacts.read(media.keyframeIndexKey))
        if not isinstance(frames, list) or not frames:
            raise DagFailure("CONTRACT_INVALID")
        seen: set[int] = set()
        for f in frames:
            if (
                not isinstance(f, dict)
                or set(f) != {"idx", "ms", "key"}
                or type(f["idx"]) is not int
                or type(f["ms"]) is not int
                or f["idx"] in seen
                or f["idx"] < 0
                or not 0 <= f["ms"] < media.durationMs
            ):
                raise DagFailure("CONTRACT_INVALID")
            scoped(self.job.job.sessionId, f["key"])
            self.artifacts.read(f["key"])
            seen.add(f["idx"])
        return sorted(frames, key=lambda f: f["ms"])

    def _pipeline(self) -> dict[str, str]:
        job = self.job
        source = {
            k: model_value(job.inputs)[k]
            for k in ("uploadId", "sourceKey", "declaredBytes", "declaredSha256", "mimeType")
        }
        media_run = self._execute("transcode", source, TranscodeOutput)
        media = TranscodeOutput.model_validate(model_value(media_run.output))
        transcribed = self._execute(
            "transcribe",
            {
                "audioWavKeys": [model_value(x) for x in media.audioWavKeys],
                "keywords": [],
                "languageBias": ["English"],
            },
            TranscribeOutput,
        )
        turns = TranscribeOutput.model_validate(model_value(transcribed.output))
        if not turns.turns:
            raise DagFailure("NO_SPEECH")
        plan_run = self._execute(
            "plan",
            {
                "session": {
                    "studentLabel": job.session.studentLabel,
                    "subjectRole": job.session.subjectRole,
                },
                "turns": [model_value(x) for x in turns.turns],
            },
            PlanOutput,
            transform=lambda p: build.words(p, turns),
        )
        plan = PlanOutput.model_validate(model_value(plan_run.output))
        subject = job.session.subject
        if subject is None:
            raise DagFailure("SUBJECT_NEEDED")
        anchor_run = self._execute(
            "subject",
            {"proxyKey": media.proxyKey, "subject": model_value(subject)},
            SubjectAnchorOutput,
        )
        anchor = SubjectAnchorOutput.model_validate(model_value(anchor_run.output))
        frames = self._frames(media)
        proxy_hash = hashlib.sha256(self.artifacts.read(media.proxyKey)).hexdigest()
        ordered = sorted(plan.remarks, key=lambda r: (r.atMs, build.lexical(r.remarkId)))
        all_times = {r.remarkId: r.atMs for r in job.inputs.remarks}
        all_times.update({r.remarkId: r.atMs for r in ordered})
        all_ids = sorted(all_times, key=lambda rid: (all_times[rid], build.lexical(rid)))
        numbers = {rid: i + 1 for i, rid in enumerate(all_ids)}
        previous_times = {
            rid: all_times[all_ids[i - 1]] if i else 0 for i, rid in enumerate(all_ids)
        }
        errors: dict[str, str] = {}
        results: list[tuple[Remark, Completed, Completed, Completed]] = []

        def branch(
            item: tuple[int, Remark],
        ) -> tuple[Remark, tuple[Completed, Completed, Completed] | None, str | None]:
            index, remark = item
            try:
                previous = previous_times[remark.remarkId]
                number = numbers[remark.remarkId]
                mrun = self._execute(
                    "moment",
                    build.moment_input(remark, previous, frames, job),
                    MomentOutput,
                    remark=remark.remarkId,
                )
                moment = MomentOutput.model_validate(model_value(mrun.output))
                srun = self._execute(
                    "subject",
                    build.subject_input(remark, moment, anchor, frames, job.session.subjectRole),
                    SubjectOutput,
                    remark=remark.remarkId,
                )
                target = SubjectOutput.model_validate(model_value(srun.output))
                trun = self._execute(
                    "track",
                    build.track_input(remark, moment, target, media, proxy_hash, job),
                    TrackOutput,
                    remark=remark.remarkId,
                )
                track = TrackOutput.model_validate(model_value(trun.output))
                file = TrackFile.model_validate(
                    model_value(self.artifacts.output(track.fileRef, "TrackFile"))
                )
                prun = self._execute(
                    "place",
                    build.place_input(remark, moment, track, file, turns, number, job),
                    PlaceOutput,
                    remark=remark.remarkId,
                    number=number,
                    upstream={"moment": mrun, "subject": srun, "track": trun},
                    transform=lambda p: build.labels(
                        p,
                        remark,
                        turns,
                        job.session.subjectRole,
                        number,
                        job.config.params.labelMaxChars,
                    ),
                )
                place = PlaceOutput.model_validate(model_value(prun.output))
                crun = self._execute(
                    "check",
                    {
                        "remarkId": remark.remarkId,
                        "marks": [model_value(m) for m in place.marks],
                        "trackFileRef": track.fileRef,
                        "transcriptTurns": [
                            {"turnId": t.turnId, "text": t.text}
                            for t in turns.turns
                            if t.turnId in remark.turnIds
                        ],
                        "momentStartMs": moment.startMs,
                        "momentEndMs": moment.endMs,
                    },
                    CheckOutput,
                    remark=remark.remarkId,
                    number=number,
                )
                return remark, (prun, trun, crun), None
            except DagFailure as failure:
                return remark, None, failure.code
            except Exception:
                return remark, None, "INFRA_EXEC"

        with ThreadPoolExecutor(max_workers=job.config.limits.fanoutConcurrency) as pool:
            for remark, completed, error in pool.map(
                branch,
                [(i, r) for i, r in enumerate(ordered) if r.aboutSubject in {"yes", "unclear"}],
            ):
                if completed:
                    results.append((remark, *completed))
                elif error:
                    errors[remark.remarkId] = error
        self._successful_branches = len(results)
        annotations: list[JsonValue] = []
        segments: list[JsonValue] = []
        for remark, prun, trun, crun in results:
            place = PlaceOutput.model_validate(model_value(prun.output))
            track = TrackOutput.model_validate(model_value(trun.output))
            checked = CheckOutput.model_validate(model_value(crun.output))
            passes = {v.markId for v in checked.verdicts if v.pass_}
            selected: list[JsonValue] = []
            for mark in place.marks:
                if mark.markId not in passes:
                    continue
                selected.append(
                    {
                        "annotationId": prun.annotations[mark.markId],
                        "markType": mark.markType,
                        "anchor": mark.anchor,
                        "arrowFrom": mark.arrowFrom,
                        "startMs": mark.startMs,
                        "endMs": mark.endMs,
                        "labelText": mark.labelText,
                        "placedBy": "ai",
                        "trackFileRef": track.fileRef,
                    }
                )
            annotations.extend(selected)
            if selected:
                segments.append(
                    {
                        "segmentId": remark.remarkId,
                        "startMs": min(m.startMs for m in place.marks),
                        "endMs": max(m.endMs for m in place.marks),
                        "annotationIds": [
                            prun.annotations[m.markId] for m in place.marks if m.markId in passes
                        ],
                        "hash": digest(selected),
                    }
                )
        if self._budget_failure is not None:
            return errors
        try:
            self._execute(
                "render",
                {
                    "kind": "preview",
                    "mode": job.session.renderMode,
                    "proxyKey": media.proxyKey,
                    "durationMs": media.durationMs,
                    "annotations": annotations,
                    "segments": segments,
                    "previousSegments": [],
                },
                RenderOutput,
            )
        except DagFailure as failure:
            if failure.code not in {"RENDER_FAIL", "STAGE_TIMEOUT"}:
                raise
        return errors
