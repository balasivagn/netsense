"""Lifecycle fault tests use an explicit in-memory service protocol fake.

Actual route/transaction and executable DAG coverage lives in scripts/local-runtime.test.ts.
"""

from __future__ import annotations

import json
import sys
from contextlib import contextmanager
from dataclasses import replace
from pathlib import Path
from typing import Iterator

import pytest

from netsense_orch.drivers import LocalDriver, LocalSandboxSpec, SandboxHandle
from netsense_orch.lifecycle import Lifecycle
from netsense_orch.service import Claim, OpenSandbox, Service, StaleJob
from netsense_runner.json_types import JsonValue

ROOT = Path(__file__).resolve().parents[3]


class ProtocolFake(Service):
    def __init__(self) -> None:
        self.rows: list[OpenSandbox] = []
        self.releases: list[dict[str, JsonValue]] = []
        self.failures: list[tuple[str, str, int, bool]] = []
        self.registration_failure = False
        self.lose_release = False
        self.stale_rows: list[StaleJob] = []

    def sandbox(self, claim: Claim, sandbox_id: str, name: str) -> None:
        if self.registration_failure:
            raise RuntimeError("REGISTRATION_REJECTED")
        self.rows.append(
            OpenSandbox(jobId=claim.job.id, sandboxId=sandbox_id, sandboxName=name, driver="local")
        )

    def fail(self, job_id: str, owner: str, attempt: int, *, stale: bool = False) -> None:
        self.failures.append((job_id, owner, attempt, stale))

    def released(self, payload: dict[str, JsonValue]) -> None:
        self.releases.append(payload)
        self.rows = [r for r in self.rows if r.sandboxId != payload["sandboxId"]]
        if self.lose_release:
            self.lose_release = False
            raise RuntimeError("RESPONSE_LOST")

    def open(self) -> list[OpenSandbox]:
        return self.rows

    def stale(self) -> list[StaleJob]:
        return self.stale_rows


class FixtureDriver(LocalDriver):
    def __init__(self, script: str, timeout: float = 2) -> None:
        self.script, self.timeout = script, timeout
        self.env: dict[str, str] = {}
        self.name = ""

    @contextmanager
    def acquire(self, spec: LocalSandboxSpec) -> Iterator[SandboxHandle]:
        self.env = dict(spec.env)
        self.name = spec.name
        command: tuple[str, ...] = (
            sys.executable,
            str(ROOT / "fixtures/synthetic/local_driver" / self.script),
        )
        if self.script == "sleep_forever.py":
            command += (str(spec.cwd / "pid"),)
        with super().acquire(replace(spec, command=command, timeout_s=self.timeout)) as handle:
            yield handle


def setup(tmp_path: Path, script: str) -> tuple[Lifecycle, ProtocolFake, Claim, FixtureDriver]:
    projection = json.loads(
        (ROOT / "fixtures/synthetic/worker_http/job-projection.json").read_text()
    )
    service = ProtocolFake()
    runtime = Lifecycle(service, tmp_path / "state", sys.executable, tmp_path)
    projection["job"]["attempt"] = 1
    projection["job"]["leaseOwner"] = runtime.owner
    import secrets

    claim = Claim(
        job=projection["job"],
        config=json.loads((ROOT / "config/pipeline_config.v1.json").read_text()),
        jobToken=secrets.token_urlsafe(32),
        timeoutS=2,
    )
    driver = FixtureDriver(script)
    runtime.driver = driver
    return runtime, service, claim, driver


@pytest.mark.parametrize("script", ["exit_success.py", "exit_nonzero.py"])
def test_exact_release_on_runner_exit(tmp_path: Path, script: str) -> None:
    runtime, service, claim, driver = setup(tmp_path, script)
    runtime.run(claim)
    assert driver.name == f"ns-{claim.job.kind}-{claim.job.sessionId}"
    assert len(service.releases) == 1
    assert service.releases[0]["exitCode"] == (0 if script == "exit_success.py" else 7)
    assert not service.rows
    assert service.failures == [(claim.job.id, runtime.owner, claim.job.attempt, False)]


def test_registration_failure_still_cleans_owned_group(tmp_path: Path) -> None:
    runtime, service, claim, _ = setup(tmp_path, "sleep_forever.py")
    service.registration_failure = True
    runtime.run(claim)
    assert len(list(runtime.root.glob("*.released.json"))) == 1
    assert service.failures and not service.releases


def test_stale_heartbeat_releases_without_requeue(tmp_path: Path) -> None:
    runtime, service, claim, _ = setup(tmp_path, "sleep_forever.py")
    service.stale_rows = [
        StaleJob.model_validate({"_id": claim.job.id, "leaseOwner": runtime.owner, "attempt": 1})
    ]
    runtime.run(claim)
    assert len(service.releases) == 1
    assert any(row[3] for row in service.failures)


def test_release_response_loss_retries_identical_tuple_after_restart(tmp_path: Path) -> None:
    runtime, service, claim, _ = setup(tmp_path, "exit_success.py")
    service.lose_release = True
    with pytest.raises(RuntimeError, match="RESPONSE_LOST"):
        runtime.run(claim)
    restarted = Lifecycle(service, runtime.root, sys.executable, tmp_path)
    restarted.sweep()
    assert service.releases[0] == service.releases[1]
    restarted.sweep()
    assert len(service.releases) == 2


def test_child_allowlist_excludes_master_credentials(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import secrets

    runtime, _, claim, driver = setup(tmp_path, "exit_success.py")
    monkeypatch.setenv("CONVEX_SERVICE_SECRET", secrets.token_urlsafe(32))
    monkeypatch.setenv("WORKER_TOKEN_SECRET", secrets.token_urlsafe(32))
    monkeypatch.setenv("CLERK_SECRET_KEY", secrets.token_urlsafe(32))
    runtime.run(claim)
    assert driver.env["NETSENSE_JOB_TOKEN"] == claim.jobToken
    assert (
        not {"CONVEX_SERVICE_SECRET", "WORKER_TOKEN_SECRET", "CLERK_SECRET_KEY"} & driver.env.keys()
    )


def test_no_receipt_never_signals_persisted_identity_or_reports_release(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    runtime, service, claim, _ = setup(tmp_path, "exit_success.py")
    (runtime.root / "unknown.job.json").write_text(
        json.dumps(
            {
                "jobId": claim.job.id,
                "sandboxId": "unknown",
                "pid": 1,
            }
        )
    )
    import os

    def forbidden(*args: object) -> None:
        pytest.fail("must not signal persisted identity")

    monkeypatch.setattr(os, "killpg", forbidden)
    runtime.sweep()
    assert not service.releases
