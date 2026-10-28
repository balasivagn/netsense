from __future__ import annotations

import hashlib
import json
import secrets
import subprocess
import threading
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import TypeVar, cast

import pytest
from pydantic import BaseModel

from netsense_runner.artifacts import Artifacts, canonical, model_value, validated
from netsense_runner.budget import Budget
from netsense_runner.clients.convex_worker import ConvexWorkerClient
from netsense_runner.clients.worker_wire import (
    CompletedStageRunWire,
    DoneRequest,
    FinishStageRequest,
    StartStageRequest,
    WorkerJobResponse,
)
from netsense_runner.context import StageContext
from netsense_runner.contracts.PipelineConfig import PipelineConfig
from netsense_runner.dag import Runner, WorkerFactory, identity
from netsense_runner.fake_workers import FakeWorker
from netsense_runner.json_types import JsonValue
from netsense_runner.persistence import WorkerClient
from netsense_runner.providers.fake import FakeProviderRefused
from netsense_runner.registry import ProviderRegistry
from netsense_runner.rules.checker import CheckerConfig
from netsense_runner.stage import StageResult, StageWorker
from netsense_runner.stages.s0_transcode import TranscodeWorker
from netsense_runner.stages.s7_check import CheckRulesWorker

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "fixtures/synthetic/dag"
M = TypeVar("M", bound=BaseModel)


class Store:
    def __init__(self) -> None:
        self.values: dict[str, bytes] = {}
        self.lock = threading.Lock()

    def read(self, key: str) -> bytes:
        with self.lock:
            if key not in self.values:
                raise FileNotFoundError("MISSING_ARTIFACT")
            return self.values[key]

    def put_new(self, key: str, data: bytes, content_type: str) -> None:
        with self.lock:
            if key in self.values and self.values[key] != data:
                raise ValueError("IMMUTABLE_ARTIFACT")
            self.values[key] = data

    def get_url(self, key: str) -> str:
        return key  # The injected transcode download accepts keys; no signing route.

    def put_bytes(self, key: str, data: bytes, content_type: str) -> None:
        self.put_new(key, data, content_type)

    def put_file(self, key: str, path: str, content_type: str) -> None:
        self.put_new(key, Path(path).read_bytes(), content_type)


@dataclass
class Ledger:
    total: float = 0
    lock: threading.Lock = field(default_factory=threading.Lock)

    def reserve(self, amount_usd: float, daily_limit_usd: float) -> bool:
        with self.lock:
            if self.total + amount_usd > daily_limit_usd:
                return False
            self.total += amount_usd
            return True


class Log:
    def event(self, name: str, **fields: str | int | float | bool | None) -> None:
        pass


@dataclass
class ApiState:
    projection: WorkerJobResponse
    starts: dict[str, StartStageRequest] = field(default_factory=dict)
    finishes: dict[str, FinishStageRequest] = field(default_factory=dict)
    persists: list[tuple[str, str, dict[str, JsonValue]]] = field(default_factory=list)
    done: list[DoneRequest] = field(default_factory=list)
    fail_route: str | None = None
    heartbeat_count: int = 0
    lock: threading.RLock = field(default_factory=threading.RLock)


class Api(ConvexWorkerClient):
    """Exercise the real typed client methods, replacing only its transport."""

    state: ApiState

    def __init__(self, projection: WorkerJobResponse) -> None:
        super().__init__("https://synthetic.invalid", secrets.token_urlsafe(24))
        object.__setattr__(self, "state", ApiState(projection))

    def _request(
        self, method: str, path: str, payload: dict[str, JsonValue] | None, response_type: type[M]
    ) -> M:
        s = self.state
        with s.lock:
            if path == s.fail_route:
                raise RuntimeError("synthetic failure")
            response: dict[str, JsonValue] = {"ok": True}
            if path == "/worker/job":
                response = model_value(s.projection)
            elif path == "/worker/heartbeat":
                s.heartbeat_count += 1
            elif path == "/worker/stageRuns/start":
                request = StartStageRequest.model_validate(payload)
                prior = [r for r in s.starts.values() if r.idempotencyKey == request.idempotencyKey]
                assert request.attempt == len(prior) + 1
                run_id = f"actual-run-{len(s.starts) + 1}"
                s.starts[run_id] = request
                response = {"stageRunId": run_id}
            elif path == "/worker/stageRuns/finish":
                finish = FinishStageRequest.model_validate(payload)
                assert finish.stageRunId in s.starts
                assert finish.stageRunId not in s.finishes
                if finish.status == "done":
                    assert any(r == finish.stageRunId for _, r, _ in s.persists)
                s.finishes[finish.stageRunId] = finish
            elif path == "/worker/done":
                s.done.append(DoneRequest.model_validate(payload))
            elif path.startswith("/worker/persist/"):
                assert payload is not None
                run_id = str(payload["stageRunId"])
                request = s.starts[run_id]
                assert run_id not in s.finishes
                contract = {
                    "transcode": "TranscodeOutput",
                    "turns": "TranscribeOutput",
                    "plan": "PlanOutput",
                    "moment": "MomentOutput",
                    "target": "SubjectOutput" if request.remarkId else "SubjectAnchorOutput",
                    "track": "TrackOutput",
                    "marks": "PlaceOutput",
                    "verdicts": "CheckOutput",
                    "render": "RenderOutput",
                }[path.rsplit("/", 1)[1]]
                validated(contract, cast(dict[str, JsonValue], payload["output"]))
                s.persists.append((path, run_id, payload))
                if path.endswith("/marks"):
                    validated("Provenance", cast(dict[str, JsonValue], payload["provenance"]))
                    output = cast(dict[str, JsonValue], payload["output"])
                    response["annotationIds"] = [
                        {
                            "markId": m["markId"],
                            "annotationId": "actual-annotation-" + str(m["markId"]),
                        }
                        for m in cast(list[dict[str, JsonValue]], output["marks"])
                    ]
            else:
                raise AssertionError("unknown route")
            return response_type.model_validate(response)


class Wrapped:
    def __init__(
        self,
        worker: StageWorker,
        run: Callable[[StageWorker, Mapping[str, JsonValue], StageContext], StageResult],
    ):
        self.id, self.stage, self.worker_type = worker.id, worker.stage, worker.worker_type
        self.input_contract, self.output_contract = worker.input_contract, worker.output_contract
        self.worker, self.callback = worker, run

    def run(self, value: Mapping[str, JsonValue], ctx: StageContext) -> StageResult:
        return self.callback(self.worker, value, ctx)


@dataclass
class Harness:
    runner: Runner
    api: Api
    store: Store
    ledger: Ledger
    cleaned: list[bool]

    def wrap(
        self,
        stage: str,
        callback: Callable[[StageWorker, Mapping[str, JsonValue], StageContext], StageResult],
        contract: str | None = None,
    ) -> None:
        pinned = next(s for s in self.api.state.projection.config.stages if s.stage == stage)
        key = (pinned.workerId, contract or stage.title() + "Input")
        factory = self.runner.workers[key]
        self.runner.workers[key] = lambda n: Wrapped(factory(n), callback)

    def completed(self) -> list[CompletedStageRunWire]:
        return [
            CompletedStageRunWire(
                jobId=self.api.state.projection.job.id,
                stageRunId=run_id,
                idempotencyKey=start.idempotencyKey,
                stage=start.stage,
                remarkId=start.remarkId,
                inputHash=start.inputHash,
                outputRef=finish.outputRef or "",
            )
            for run_id, start in self.api.state.starts.items()
            if (finish := self.api.state.finishes.get(run_id)) and finish.status == "done"
        ]


@pytest.fixture(scope="session")
def source() -> bytes:
    # All generated task media stays inside the managed workspace.
    p = ROOT / ".orca-scratch/dag-source.mp4"
    p.parent.mkdir(exist_ok=True)
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=black:s=320x180:r=10:d=3",
            "-f",
            "lavfi",
            "-i",
            "anullsrc=r=24000:cl=mono",
            "-shortest",
            "-c:v",
            "libx264",
            "-c:a",
            "aac",
            str(p),
        ],
        check=True,
    )
    return p.read_bytes()


@pytest.fixture
def harness(monkeypatch: pytest.MonkeyPatch, source: bytes) -> Harness:
    monkeypatch.setenv("NETSENSE_ENV", "test")
    projection = json.loads(
        (ROOT / "fixtures/synthetic/worker_http/job-projection.json").read_text()
    )
    config = PipelineConfig.model_validate_json(
        (ROOT / "config/pipeline_config.v1.json").read_text()
    )
    config.limits.fanoutConcurrency = 2
    for stage in config.stages:
        if stage.stage not in {"transcode", "check"}:
            stage.provider, stage.workerId = "fake", stage.stage + ".synthetic-test@1"
            stage.model = None
        stage.retry = 0
    projection["config"] = model_value(config)
    projection["session"]["subject"] = {
        "frameMs": 0,
        "point": {"x": 0.47, "y": 0.3},
        "role": "batter",
        "selectedBy": "coach",
        "selectedAt": 1,
    }
    projection["inputs"]["declaredBytes"] = len(source)
    projection["inputs"]["declaredSha256"] = hashlib.sha256(source).hexdigest()
    api = Api(WorkerJobResponse.model_validate(projection))
    store = Store()
    store.put_new(projection["inputs"]["sourceKey"], source, "video/mp4")
    workers: dict[tuple[str, str], WorkerFactory] = {}
    for stage in config.stages:
        contracts = (
            ["SubjectAnchorInput", "SubjectInput"]
            if stage.stage == "subject"
            else [stage.stage.title() + "Input"]
        )
        for contract in contracts:
            if stage.stage == "transcode":

                def transcode(_n: int | None) -> StageWorker:
                    return TranscodeWorker(download=lambda key: iter([store.read(key)]))

                factory: WorkerFactory = transcode
            elif stage.stage == "check":

                def checker(n: int | None) -> StageWorker:
                    return CheckRulesWorker(store.read, CheckerConfig(), "batter", n)

                factory = checker
            else:

                def fake(
                    n: int | None, worker_id: str = stage.workerId, contract: str = contract
                ) -> StageWorker:
                    return FakeWorker(worker_id, contract, FIXTURES, store)

                factory = fake
            workers[(stage.workerId, contract)] = factory
    ledger, cleaned = Ledger(), []
    client: WorkerClient = api  # Static conformance with the real client and frozen methods.
    runner = Runner(
        client=client,
        artifacts=Artifacts("synthetic-session", store),
        storage=store,
        budget=Budget(config.limits, ledger),
        providers=ProviderRegistry({}),
        workers=workers,
        log=Log(),
        cleanup=lambda: cleaned.append(True),
        wait=lambda _: None,
    )
    return Harness(runner, api, store, ledger, cleaned)


def test_full_dag_validated_artifacts_verbatim_subject_and_actual_ids(harness: Harness) -> None:
    h = harness
    outcome = h.runner.run()
    assert outcome.status == "waiting_for_coach" and not outcome.branch_errors
    assert h.cleaned == [True] and h.runner.heartbeat_stopped.is_set()
    assert len(h.api.state.done) == 1
    assert {p.rsplit("/", 1)[1] for p, _, _ in h.api.state.persists} == {
        "transcode",
        "turns",
        "plan",
        "moment",
        "target",
        "track",
        "marks",
        "verdicts",
        "render",
    }
    assert len(h.api.state.starts) == 15  # Four upstream + two five-stage branches + render.
    tracks = [
        json.loads(data) for key, data in h.store.values.items() if key.endswith(".track.json")
    ]
    assert len(tracks) == 2
    expected_box = json.loads((FIXTURES / "people.json").read_text())["people"][1]["box"]
    for track in tracks:
        validated("TrackFile", track)
        assert track["subjectOnly"] is True
        assert {canonical(f["box"]) for f in track["frames"]} == {canonical(expected_box)}
    turns = json.loads((FIXTURES / "transcribe.json").read_text())["turns"]
    for path, run, payload in h.api.state.persists:
        output = cast(dict[str, JsonValue], payload["output"])
        if path.endswith("/marks"):
            marks = cast(list[dict[str, JsonValue]], output["marks"])
            index = int(str(output["remarkId"])[-1]) - 1
            assert marks[0]["labelText"] == turns[index]["text"]
            provenance = cast(dict[str, JsonValue], payload["provenance"])
            ids = cast(dict[str, str], provenance["stageRunIds"])
            assert set(ids) == {"moment", "subject", "track", "place"} and ids["place"] == run
            assert all(i in h.api.state.starts for i in ids.values())
    render_key = next(k for k in h.store.values if k.endswith("render-test-stub.json"))
    render = json.loads(h.store.read(render_key))
    assert render["testStub"] is True
    assert len(render["input"]["annotations"]) == 2
    for annotation in render["input"]["annotations"]:
        assert annotation["annotationId"].startswith("actual-annotation-")
        assert annotation["placedBy"] == "ai"
    assert all(r.remarkId != "r3" for r in h.api.state.starts.values())
    assert h.ledger.total == 0
    for completed in h.completed():
        raw = h.store.read(completed.outputRef)
        assert raw and completed.stageRunId in completed.outputRef


def test_resume_skips_all_work_persistence_and_charges(harness: Harness) -> None:
    h = harness
    assert h.runner.run().status == "waiting_for_coach"
    h.api.state.projection.inputs.completedStageRuns = h.completed()
    starts, persists = len(h.api.state.starts), len(h.api.state.persists)
    before = h.runner.budget.usage
    assert h.runner.run().status == "waiting_for_coach"
    assert len(h.api.state.starts) == starts and len(h.api.state.persists) == persists
    assert h.runner.budget.usage == before and h.ledger.total == 0


def test_retry_sequential_actual_ids_backoff_and_timeout(harness: Harness) -> None:
    h = harness
    clock = [time.monotonic()]
    h.runner.clock = lambda: clock[0]
    waits: list[float] = []
    h.runner.wait = waits.append
    pinned = next(s for s in h.api.state.projection.config.stages if s.stage == "transcribe")
    pinned.retry = 2
    seen: list[tuple[str, int, float]] = []

    def timeout(
        worker: StageWorker, value: Mapping[str, JsonValue], ctx: StageContext
    ) -> StageResult:
        seen.append((ctx.stage_run_id, ctx.attempt, ctx.deadline_monotonic))
        result = worker.run(value, ctx)
        if ctx.attempt < 3:
            clock[0] = ctx.deadline_monotonic + 0.01
        return result

    h.wrap("transcribe", timeout)
    assert h.runner.run().status == "waiting_for_coach"
    assert [a for _, a, _ in seen] == [1, 2, 3] and waits == [2, 8]
    assert len({r for r, _, _ in seen}) == 3
    for run, _, _ in seen[:2]:
        error = h.api.state.finishes[run].errorCode
        assert error is not None and error.root == "STAGE_TIMEOUT"
        assert not any(r == run for _, r, _ in h.api.state.persists)


def test_failure_isolation_and_bounded_concurrent_fanout(harness: Harness) -> None:
    h = harness
    gate = threading.Barrier(2)
    active, peak = [0], [0]
    lock = threading.Lock()

    def moment(
        worker: StageWorker, value: Mapping[str, JsonValue], ctx: StageContext
    ) -> StageResult:
        with lock:
            active[0] += 1
            peak[0] = max(peak[0], active[0])
        gate.wait(timeout=5)
        with lock:
            active[0] -= 1
        if ctx.remark_id == "r1":
            raise RuntimeError("synthetic private error text")
        return worker.run(value, ctx)

    h.wrap("moment", moment)
    result = h.runner.run()
    assert result.status == "waiting_for_coach"
    assert result.branch_errors == {"r1": "INFRA_EXEC"}
    assert peak == [2]
    assert any(s.stage == "check" and s.remarkId == "r2" for s in h.api.state.starts.values())
    assert any(s.stage == "render" for s in h.api.state.starts.values())
    assert "synthetic private" not in str(result)


@pytest.mark.parametrize("bad", ["nan", "status", "output", "usage", "error"])
def test_bad_stage_results_fail_before_persist(harness: Harness, bad: str) -> None:
    def broken(
        worker: StageWorker, value: Mapping[str, JsonValue], ctx: StageContext
    ) -> StageResult:
        result = worker.run(value, ctx)
        if bad == "nan":
            result["cost_usd"] = float("nan")
        elif bad == "status":
            result["status"] = cast(object, "unknown")  # type: ignore[typeddict-item]
        elif bad == "output":
            result["output"] = {"turns": [], "audioDurationMs": -1, "providerSessionIds": []}
        elif bad == "usage":
            result["usage"]["samFrames"] = -1
        else:
            result["error_code"] = "private error"
        return result

    harness.wrap("transcribe", broken)
    result = harness.runner.run()
    assert result.error_code == "CONTRACT_INVALID"
    assert not any(p.endswith("/turns") for p, _, _ in harness.api.state.persists)
    assert harness.cleaned == [True] and len(harness.api.state.done) == 1


def test_budget_stops_before_tracking_work(harness: Harness) -> None:
    h = harness
    config = h.api.state.projection.config
    config.limits.jobSamFrameCap = 1  # Anchor spends the only admitted frame.
    h.runner.budget = Budget(config.limits, h.ledger)
    result = h.runner.run()
    assert set(result.branch_errors.values()) == {"BUDGET_SAM_FRAMES"}
    assert h.runner.budget.usage.sam_frames == 1
    assert not any(k.endswith(".track.json") for k in h.store.values)
    assert h.ledger.total == 0


@pytest.mark.parametrize("route", ["/worker/job", "/worker/done", "/worker/heartbeat"])
def test_cleanup_even_network_or_done_failure(harness: Harness, route: str) -> None:
    h = harness
    h.api.state.fail_route = route
    h.runner.heartbeat_interval = 0.001
    if route.endswith("heartbeat"):

        def pause(
            worker: StageWorker, value: Mapping[str, JsonValue], ctx: StageContext
        ) -> StageResult:
            assert h.runner.heartbeat_stopped.wait(timeout=2)
            return worker.run(value, ctx)

        h.wrap("transcribe", pause)
    result = h.runner.run()
    assert result.status == "failed"
    assert h.runner.heartbeat_stopped.is_set() and h.cleaned == [True]


def test_cancelled_path_calls_done_once_and_cleanup(harness: Harness) -> None:
    harness.runner.cancelled.set()
    result = harness.runner.run()
    assert result.status == "failed" and result.error_code == "INFRA_NETWORK"
    assert len(harness.api.state.done) == 1 and harness.cleaned == [True]


def test_subject_retrack_after_anchor_failure_computes_only_missing_moments(
    harness: Harness,
) -> None:
    h = harness

    def anchor_fail(
        worker: StageWorker, value: Mapping[str, JsonValue], ctx: StageContext
    ) -> StageResult:
        return FakeWorker._failure("SUBJECT_NEEDED", "needs_coach")

    h.wrap("subject", anchor_fail, "SubjectAnchorInput")
    first = h.runner.run()
    assert first.error_code == "SUBJECT_NEEDED"
    prior = h.completed()
    assert {r.stage for r in prior} == {"transcode", "transcribe", "plan"}
    h.api.state.projection.job.id = "synthetic-retrack"
    h.api.state.projection.job.kind = "subject_retrack"
    h.api.state.projection.inputs.completedStageRuns = prior
    subject = h.api.state.projection.session.subject
    assert subject is not None
    subject.point.x, subject.selectedAt = 0.09, 2
    stage = next(s for s in h.api.state.projection.config.stages if s.stage == "subject")
    h.runner.workers[(stage.workerId, "SubjectAnchorInput")] = lambda _: FakeWorker(
        stage.workerId, "SubjectAnchorInput", FIXTURES, h.store
    )
    starts = len(h.api.state.starts)
    assert h.runner.run().status == "waiting_for_coach"
    new = list(h.api.state.starts.values())[starts:]
    assert not any(r.stage in {"transcode", "transcribe", "plan"} for r in new)
    assert sum(r.stage == "moment" for r in new) == 2
    tracks = [
        json.loads(data) for key, data in h.store.values.items() if key.endswith(".track.json")
    ]
    expected = json.loads((FIXTURES / "people.json").read_text())["people"][0]["box"]
    assert all(f["box"] == expected for t in tracks for f in t["frames"])


def test_subject_retrack_reuses_completed_moments_and_no_old_downstream(harness: Harness) -> None:
    h = harness
    assert h.runner.run().status == "waiting_for_coach"
    prior = h.completed()
    h.api.state.projection.inputs.completedStageRuns = prior
    h.api.state.projection.job.id = "synthetic-retrack"
    h.api.state.projection.job.kind = "subject_retrack"
    starts = len(h.api.state.starts)
    assert h.runner.run().status == "waiting_for_coach"
    new = list(h.api.state.starts.values())[starts:]
    assert not any(r.stage in {"transcode", "transcribe", "plan", "moment"} for r in new)
    assert sum(r.stage == "subject" for r in new) == 3
    assert sum(r.stage == "track" for r in new) == 2


def test_missing_retrack_prerequisite_fails_safely(harness: Harness) -> None:
    h = harness
    h.api.state.projection.job.kind = "subject_retrack"
    result = h.runner.run()
    assert result.status == "failed" and result.error_code == "CONTRACT_INVALID"
    assert not h.api.state.starts and h.cleaned == [True]


@pytest.mark.parametrize("kind", ["finalize", "stage_retry", "remark_retrack"])
def test_pending_job_kinds_rejected(harness: Harness, kind: str) -> None:
    harness.api.state.projection.job.kind = kind  # type: ignore[assignment]
    assert harness.runner.run().error_code == "CONTRACT_INVALID"
    assert not harness.api.state.starts


@pytest.mark.parametrize("environment", [None, "", "prod", "production", "PROD", "staging"])
def test_fake_workers_refuse_unset_or_production(
    monkeypatch: pytest.MonkeyPatch, environment: str | None
) -> None:
    if environment is None:
        monkeypatch.delenv("NETSENSE_ENV", raising=False)
    else:
        monkeypatch.setenv("NETSENSE_ENV", environment)
    with pytest.raises(FakeProviderRefused):
        FakeWorker("transcribe.synthetic-test@1", "TranscribeInput", FIXTURES, Store())


def test_identity_is_canonical_unambiguous_and_subject_sensitive() -> None:
    a = identity("job", "moment", None, "worker", {"a": 1, "b": 2})
    assert a == identity("job", "moment", None, "worker", {"b": 2, "a": 1})
    assert a != identity("job", "moment", "null", "worker", {"b": 2, "a": 1})
    assert identity("job|x", "moment", None, "w", {}) != identity("job", "moment", "x", "w", {})


def test_subject_lost_does_not_switch_to_other_visible_person(harness: Harness) -> None:
    h = harness
    stage = next(s for s in h.api.state.projection.config.stages if s.stage == "track")
    h.runner.workers[(stage.workerId, "TrackInput")] = lambda _: FakeWorker(
        stage.workerId, "TrackInput", FIXTURES, h.store, stream_fixture="stream_lost.json"
    )
    result = h.runner.run()
    assert result.error_code == "SEG_NO_TRACK"
    assert set(result.branch_errors.values()) == {"SEG_NO_TRACK"}
    assert not any(k.endswith(".track.json") for k in h.store.values)
    stream = json.loads((FIXTURES / "stream_lost.json").read_text())
    assert all(len(f["objects"]) == 2 for f in stream["frames"])


def test_swap_checker_prevents_swapped_marks_from_render(harness: Harness) -> None:
    h = harness
    stage = next(s for s in h.api.state.projection.config.stages if s.stage == "track")
    h.runner.workers[(stage.workerId, "TrackInput")] = lambda _: FakeWorker(
        stage.workerId, "TrackInput", FIXTURES, h.store, stream_fixture="stream_swap.json"
    )
    assert h.runner.run().status == "waiting_for_coach"
    key = next(k for k in h.store.values if k.endswith("render-test-stub.json"))
    assert json.loads(h.store.read(key))["input"]["annotations"] == []
    tracks = [
        json.loads(data) for key, data in h.store.values.items() if key.endswith(".track.json")
    ]
    assert all(t["subjectOnly"] is True and t["swaps"] for t in tracks)
    verdicts = [p["output"] for path, _, p in h.api.state.persists if path.endswith("/verdicts")]
    assert all(
        v["remarkStatus"] == "player_missing" for v in cast(list[dict[str, JsonValue]], verdicts)
    )


def test_subject_retrack_computes_one_missing_moment_only(harness: Harness) -> None:
    h = harness
    assert h.runner.run().status == "waiting_for_coach"
    h.api.state.projection.inputs.completedStageRuns = [
        r for r in h.completed() if not (r.stage == "moment" and r.remarkId == "r1")
    ]
    h.api.state.projection.job.id = "synthetic-retrack"
    h.api.state.projection.job.kind = "subject_retrack"
    starts = len(h.api.state.starts)
    assert h.runner.run().status == "waiting_for_coach"
    new = list(h.api.state.starts.values())[starts:]
    assert [(r.stage, r.remarkId) for r in new if r.stage == "moment"] == [("moment", "r1")]
    assert not any(r.stage in {"transcode", "transcribe", "plan"} for r in new)


@pytest.mark.parametrize("damage", ["missing", "invalid", "receipt"])
def test_resume_requires_existing_valid_artifact_and_receipt(harness: Harness, damage: str) -> None:
    h = harness
    assert h.runner.run().status == "waiting_for_coach"
    completed = h.completed()
    h.api.state.projection.inputs.completedStageRuns = completed
    key = next(r.outputRef for r in completed if r.stage == "transcribe")
    if damage == "missing":
        del h.store.values[key]
    elif damage == "invalid":
        h.store.values[key] = b"{}"
    else:
        raw = json.loads(h.store.read(key + ".receipt"))
        raw["configVersion"] += 1
        h.store.values[key + ".receipt"] = canonical(raw)
    starts = len(h.api.state.starts)
    result = h.runner.run()
    assert result.status == "failed" and result.error_code == "CONTRACT_INVALID"
    assert len(h.api.state.starts) == starts


@pytest.mark.parametrize("guard", ["tokens", "daily"])
def test_budget_preflight_blocks_provider_before_call(harness: Harness, guard: str) -> None:
    h = harness
    called: list[bool] = []

    def guarded(
        worker: StageWorker, value: Mapping[str, JsonValue], ctx: StageContext
    ) -> StageResult:
        if guard == "tokens":
            ctx.budget.reserve_spark_tokens(400001, 0)
        else:
            ctx.budget.reserve_spend(16)
        called.append(True)
        return worker.run(value, ctx)

    h.wrap("transcribe", guarded)
    result = h.runner.run()
    assert result.status == "failed"
    assert result.error_code == ("BUDGET_TOKENS" if guard == "tokens" else "BUDGET_DAILY")
    assert not called and h.ledger.total == 0
    assert not any(p.endswith("/turns") for p, _, _ in h.api.state.persists)


def test_fanout_cap_one_serializes_branches(harness: Harness) -> None:
    h = harness
    h.api.state.projection.config.limits.fanoutConcurrency = 1
    active, peak = [0], [0]
    lock = threading.Lock()

    def observe(
        worker: StageWorker, value: Mapping[str, JsonValue], ctx: StageContext
    ) -> StageResult:
        with lock:
            active[0] += 1
            peak[0] = max(peak[0], active[0])
        try:
            time.sleep(0.01)
            return worker.run(value, ctx)
        finally:
            with lock:
                active[0] -= 1

    h.wrap("moment", observe)
    assert h.runner.run().status == "waiting_for_coach"
    assert peak == [1]


def test_persistence_failure_finishes_failed_and_still_cleans(harness: Harness) -> None:
    h = harness
    h.api.state.fail_route = "/worker/persist/turns"
    result = h.runner.run()
    assert result.status == "failed" and h.cleaned == [True]
    run = next(r for r, s in h.api.state.starts.items() if s.stage == "transcribe")
    assert h.api.state.finishes[run].status == "failed"
    assert h.api.state.finishes[run].outputRef is None


def test_finish_failure_still_calls_done_and_cleans(harness: Harness) -> None:
    h = harness
    h.api.state.fail_route = "/worker/stageRuns/finish"
    assert h.runner.run().status == "failed"
    assert h.cleaned == [True] and len(h.api.state.done) == 1
    assert h.runner.heartbeat_stopped.is_set()


def test_module_entry_requires_host_dependencies(capsys: pytest.CaptureFixture[str]) -> None:
    from netsense_runner.__main__ import main

    assert main() == 78
    assert capsys.readouterr().err == "RUNNER_DEPENDENCIES_REQUIRED\n"


def test_numbered_labels_count_all_session_remarks(harness: Harness) -> None:
    from netsense_runner.clients.worker_wire import RemarkWire

    h = harness
    h.api.state.projection.inputs.remarks = [
        RemarkWire.model_validate_json((FIXTURES / "prior-note.json").read_text())
    ]
    observed: dict[str, int] = {}

    def numbered(
        worker: StageWorker, value: Mapping[str, JsonValue], ctx: StageContext
    ) -> StageResult:
        observed[str(value["remarkId"])] = int(str(value["remarkNumber"]))
        result = worker.run(value, ctx)
        assert result["output"] is not None
        output = dict(result["output"])
        marks = cast(list[dict[str, JsonValue]], output["marks"])
        marks[0]["labelSpan"], marks[0]["neutralLabel"] = None, "Remark"
        result["output"] = output
        return result

    h.wrap("place", numbered)
    assert h.runner.run().status == "waiting_for_coach"
    assert observed == {"r1": 2, "r2": 3}
    verdicts = [p["output"] for path, _, p in h.api.state.persists if path.endswith("/verdicts")]
    assert all(v["remarkStatus"] == "ok" for v in cast(list[dict[str, JsonValue]], verdicts))


@pytest.mark.parametrize("case", ["whole", "splitWord", "surrogate", "long"])
def test_labels_copy_utf16_whole_words_and_trim_cap(case: str) -> None:
    from netsense_runner.contracts.PlaceOutput import PlaceOutput
    from netsense_runner.contracts.PlanOutput import PlanOutput
    from netsense_runner.contracts.TranscribeOutput import TranscribeOutput
    from netsense_runner.input_builders import labels, utf16

    data = json.loads((FIXTURES / "unicode.json").read_text())
    turns = TranscribeOutput.model_validate_json((FIXTURES / "transcribe.json").read_text())
    turns.turns[0].text = data["text"]
    remark = PlanOutput.model_validate_json((FIXTURES / "plan.json").read_text()).remarks[0]
    span = data[case]
    if case == "long":
        span = {"start": 0, "end": utf16(data["text"])}
    output = PlaceOutput.model_validate(
        {
            "remarkId": remark.remarkId,
            "why": "",
            "marks": [
                {
                    "markId": "synthetic-mark",
                    "markType": "circle",
                    "anchor": "box_top",
                    "arrowFrom": None,
                    "startMs": 0,
                    "endMs": 100,
                    "labelSpan": {"turnId": "t1", **span},
                    "labelText": "",
                    "neutralLabel": None,
                }
            ],
        }
    )
    if case in {"splitWord", "surrogate"}:
        with pytest.raises(ValueError):
            labels(output, remark, turns, "batter", 1, 60)
    else:
        copied = labels(output, remark, turns, "batter", 1, 60).marks[0]
        assert copied.labelSpan is not None
        expected = (
            data["text"]
            .encode("utf-16-le")[copied.labelSpan.start * 2 : copied.labelSpan.end * 2]
            .decode("utf-16-le")
        )
        assert copied.labelText.encode() == expected.encode()
        assert utf16(copied.labelText) <= 60
        if case == "long":
            assert copied.labelSpan.end < span["end"]


def test_cleanup_failure_does_not_repeat_done(harness: Harness) -> None:
    def broken_cleanup() -> None:
        raise RuntimeError("synthetic cleanup failure")

    harness.runner.cleanup = broken_cleanup
    assert harness.runner.run().status == "failed"
    assert len(harness.api.state.done) == 1 and harness.runner.heartbeat_stopped.is_set()
