"""Explicit local fake bootstrap; pinned config is authoritative, paid work fails closed."""

from __future__ import annotations

import hashlib
import os
from collections.abc import Mapping
from pathlib import Path

from netsense_runner.artifacts import Artifacts
from netsense_runner.budget import Budget
from netsense_runner.clients.convex_worker import ConvexWorkerClient
from netsense_runner.context import StageContext
from netsense_runner.dag import Runner, WorkerFactory
from netsense_runner.fake_workers import FakeWorker
from netsense_runner.host_storage import HttpStorage, LocalArtifacts
from netsense_runner.json_types import JsonValue
from netsense_runner.registry import ProviderRegistry
from netsense_runner.rules.checker import CheckerConfig
from netsense_runner.stage import StageResult, StageWorker
from netsense_runner.stages.s0_transcode import TranscodeWorker
from netsense_runner.stages.s7_check import CheckRulesWorker
from netsense_runner.stages.s8_render import RenderWorker


class NoPaidLedger:
    def reserve(self, amount_usd: float, daily_limit_usd: float) -> bool:
        return amount_usd == 0  # No atomic paid ledger exists: never authorize spend.


class SafeLog:
    def event(self, name: str, **fields: str | int | float | bool | None) -> None:
        pass  # Host deliberately emits no payloads, URLs or arbitrary exception details.


class BoundedWorker:
    def __init__(self, worker: StageWorker, storage: HttpStorage) -> None:
        self.worker, self.storage = worker, storage
        self.id, self.stage, self.worker_type = worker.id, worker.stage, worker.worker_type
        self.input_contract, self.output_contract = worker.input_contract, worker.output_contract

    def run(self, value: Mapping[str, JsonValue], ctx: StageContext) -> StageResult:
        self.storage.deadline.value = ctx.deadline_monotonic
        try:
            result = self.worker.run(value, ctx)
            if result["cost_usd"] != 0:
                raise ValueError("PAID_WORK_REFUSED")
            return result
        finally:
            self.storage.deadline.value = None


def build_runner(job_id: str) -> Runner:
    if (
        os.environ.get("NETSENSE_ENV") not in {"test", "development"}
        or os.environ.get("NETSENSE_LOCAL_FAKE") != "1"
    ):
        raise ValueError("LOCAL_FAKE_REFUSED")
    client = ConvexWorkerClient(os.environ["CONVEX_SITE_URL"], os.environ["NETSENSE_JOB_TOKEN"])
    job = client.get_job()
    if job.job.id != job_id or job.job.attempt != 1:
        # Non-done attempts/counters aren't projected. Never blindly resume them.
        raise ValueError("RECOVERY_PARTIAL")
    artifacts = LocalArtifacts(Path(os.environ["NETSENSE_ARTIFACT_ROOT"]), job.job.sessionId)
    storage = HttpStorage(
        os.environ["VM_API_BASE_URL"],
        os.environ["NETSENSE_JOB_TOKEN"],
        job.job.sessionId,
        Path(os.environ["NETSENSE_RUNNER_SCRATCH"]),
        artifacts,
    )
    admission = storage.scratch / (hashlib.sha256(job_id.encode()).hexdigest() + ".admitted")
    try:
        fd = os.open(admission, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.fsync(fd)
        os.close(fd)
    except FileExistsError:
        raise ValueError("RECOVERY_PARTIAL") from None
    fixtures = Path(os.environ["NETSENSE_FAKE_FIXTURES"]).resolve()
    # Explicit fixture path, never loaded in normal runtime or production.
    if fixtures.parts[-3:] != ("fixtures", "synthetic", "dag"):
        raise ValueError("FAKE_FIXTURES_REFUSED")
    workers: dict[tuple[str, str], WorkerFactory] = {}
    checker_config = CheckerConfig(
        job.config.params.minMarkCoverage, job.config.params.labelMaxChars
    )
    for stage in job.config.stages:
        if stage.stage == "transcode":
            worker: StageWorker = TranscodeWorker(
                download=lambda url: storage.download(
                    url, timeout_s=storage.remaining(30), max_bytes=2 * 1024**3
                )
            )
            if stage.workerId != worker.id or stage.provider != "local" or stage.model is not None:
                raise ValueError("PINNED_WORKER_MISMATCH")

            def transcode_factory(n: int | None, w: StageWorker = worker) -> StageWorker:
                return BoundedWorker(w, storage)

            workers[(worker.id, worker.input_contract)] = transcode_factory
        elif stage.stage == "check":
            if stage.workerId != CheckRulesWorker.id or stage.provider != "local":
                raise ValueError("PINNED_WORKER_MISMATCH")
            workers[(stage.workerId, "CheckInput")] = lambda n: BoundedWorker(
                CheckRulesWorker(artifacts.read, checker_config, job.session.subjectRole, n),
                storage,
            )
        elif stage.stage == "render":
            renderer = RenderWorker(
                download=storage.download, track_loader=storage.load, object_exists=storage.exists
            )
            if (
                stage.workerId != renderer.id
                or stage.provider != "local"
                or stage.model is not None
            ):
                raise ValueError("PINNED_WORKER_MISMATCH")
            workers[(renderer.id, "RenderInput")] = lambda n: BoundedWorker(renderer, storage)
        else:
            if (
                stage.provider != "fake"
                or stage.model is not None
                or stage.workerId != stage.stage + ".synthetic-test@1"
            ):
                raise ValueError("PINNED_FAKE_REQUIRED")
            contracts = (
                ["SubjectAnchorInput", "SubjectInput"]
                if stage.stage == "subject"
                else [stage.stage.title() + "Input"]
            )
            for contract in contracts:

                def factory(
                    n: int | None, wid: str = stage.workerId, c: str = contract
                ) -> StageWorker:
                    return BoundedWorker(FakeWorker(wid, c, fixtures, artifacts), storage)

                workers[(stage.workerId, contract)] = factory
    return Runner(
        client=client,
        artifacts=Artifacts(job.job.sessionId, artifacts),
        storage=storage,
        budget=Budget(job.config.limits, NoPaidLedger()),
        providers=ProviderRegistry({}),
        workers=workers,
        log=SafeLog(),
        cleanup=lambda: None,
        heartbeat_interval=min(20, job.config.limits.jobLeaseS / 3),
    )
