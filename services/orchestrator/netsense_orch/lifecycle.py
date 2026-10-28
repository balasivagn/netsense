"""Sequential local lifecycle with durable release delivery and no automatic requeue."""

from __future__ import annotations

import fcntl
import json
import math
import os
import stat
import time
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

from netsense_orch.drivers import LocalDriver, LocalSandboxSpec, LocalSandboxWaitTimeout
from netsense_orch.service import Claim, Service
from netsense_runner.clients.convex_worker import WorkerClientError
from netsense_runner.json_types import JsonValue

# This is the entire child environment. Never forward the parent environment.
CHILD_ENV = frozenset(
    {
        "PATH",
        "HEARTBEAT_S",
        "NETSENSE_ENV",
        "NETSENSE_LOCAL_FAKE",
        "CONVEX_SITE_URL",
        "VM_API_BASE_URL",
        "NETSENSE_ARTIFACT_ROOT",
        "NETSENSE_FAKE_FIXTURES",
        "NETSENSE_RUNNER_SCRATCH",
        "TMPDIR",
    }
)


def durable(path: Path, value: dict[str, JsonValue]) -> None:
    temp = path.with_name(path.name + "." + uuid4().hex + ".tmp")
    with temp.open("w") as output:
        json.dump(value, output)
        output.flush()
        os.fsync(output.fileno())
    os.replace(temp, path)
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def read_record(path: Path) -> dict[str, Any]:
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > 65536:
            raise ValueError("INVALID_JOURNAL")
        value = json.loads(source.read(65537))
        if not isinstance(value, dict):
            raise ValueError("INVALID_JOURNAL")
        return value


def interval(name: str, default: float) -> float:
    value = float(os.environ.get(name, str(default)))
    bounds = {
        "HEARTBEAT_S": (1, 60),
        "SWEEPER_INTERVAL_S": (1, 86400),
        "ORCH_POLL_INTERVAL_MS": (100, 60000),
    }
    minimum, maximum = bounds[name]
    if not math.isfinite(value) or not minimum <= value <= maximum:
        raise ValueError("INVALID_INTERVAL")
    return value


class Lifecycle:
    def __init__(self, service: Service, root: Path, python: str, cwd: Path) -> None:
        self.service, self.root, self.python, self.cwd = service, root, python, cwd
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.owner = "local-" + uuid4().hex
        self.driver = LocalDriver()
        self.watch_s = interval("HEARTBEAT_S", 15)
        self.sweep_s = interval("SWEEPER_INTERVAL_S", 180)
        self.poll_s = interval("ORCH_POLL_INTERVAL_MS", 2000) / 1000
        self.next_sweep = 0.0

    def run(self, claim: Claim) -> None:
        if claim.job.leaseOwner != self.owner:
            raise ValueError("CLAIM_OWNER_MISMATCH")
        owner, attempt = claim.job.leaseOwner, claim.job.attempt
        env = {key: value for key, value in os.environ.items() if key in CHILD_ENV}
        env["NETSENSE_JOB_TOKEN"] = claim.jobToken
        gate = self.root / (uuid4().hex + ".start")
        env["NETSENSE_RUNNER_START_FILE"] = str(gate.resolve())
        name = "ns-" + claim.job.kind + "-" + claim.job.sessionId
        spec = LocalSandboxSpec(
            name=name,
            command=(self.python, "-m", "netsense_runner", "--job", claim.job.id),
            cwd=self.cwd,
            env=env,
            timeout_s=claim.timeoutS,
            state_dir=self.root,
        )
        handle_id: str | None = None
        journal: Path | None = None
        try:
            with self.driver.acquire(spec) as handle:
                handle_id = handle.sandbox_id
                journal = self.root / (handle_id + ".job.json")
                # Journal before remote registration; registration response may be lost.
                durable(
                    journal,
                    {
                        "jobId": claim.job.id,
                        "sandboxId": handle_id,
                        "sandboxName": name,
                        "attempt": claim.job.attempt,
                        "leaseOwner": claim.job.leaseOwner,
                        "registered": False,
                        "environment": os.environ.get("NETSENSE_ENV", "test"),
                        "serviceOrigin": self.service.origin,
                    },
                )
                self.service.sandbox(claim, handle_id, name)
                durable(gate, {"sandboxId": handle_id})
                next_watch = time.monotonic()
                while True:
                    try:
                        handle.wait(0.2)
                        # Exit zero is not proof that /worker/done was persisted.
                        # The mutation preserves terminal jobs and only fails this
                        # exact owned attempt if it is still running.
                        self.service.fail(claim.job.id, owner, attempt)
                        break
                    except LocalSandboxWaitTimeout:
                        now = time.monotonic()
                        if now >= next_watch:
                            next_watch = now + self.watch_s
                            try:
                                decision = self.service.control(claim.job.id, owner, attempt)
                            except Exception:
                                # No authoritative decision: retain owned worker; guardian
                                # independently enforces the immutable hard deadline.
                                decision = None
                            if decision is not None and decision.decision != "continue":
                                break
                        if now >= self.next_sweep:
                            try:
                                self.sweep()
                            except Exception:
                                pass  # Retain receipts and keep watching the owned child.
                            self.next_sweep = time.monotonic() + self.sweep_s
        except Exception:
            self.service.fail(claim.job.id, owner, attempt)
        finally:
            # Receipt is written only after the guardian's final signal and reap.
            # Failed cleanup leaves its journal for reconciliation; never claim release.
            gate.unlink(missing_ok=True)
            if handle_id and journal:
                self.sweep()

    def sweep(self) -> None:
        for handle in list(LocalDriver._cleanup_pending.values()):
            try:
                handle.terminate()
            except Exception:
                pass  # Retain live ownership for the next sweep.
        # Cross-process serialization protects immutable retry tuple and delivery state.
        with (self.root / ".reconcile.lock").open("a") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return  # Another local reconciler owns delivery; never block a live watch.
            self._reconcile()

    def _reconcile(self) -> None:
        delivery_error: WorkerClientError | None = None
        deadline = time.monotonic() + 10
        open_rows = {row.sandboxId: row for row in self.service.open() if row.driver == "local"}
        for journal in self.root.glob("*.job.json"):
            if time.monotonic() >= deadline:
                break
            try:
                entry = read_record(journal)
                sandbox_id = entry["sandboxId"]
                if (
                    not isinstance(sandbox_id, str)
                    or str(UUID(sandbox_id)) != sandbox_id
                    or journal.name != sandbox_id + ".job.json"
                    or entry.get("environment") != os.environ.get("NETSENSE_ENV", "test")
                    or entry.get("serviceOrigin") != self.service.origin
                ):
                    continue
                receipt_path = self.root / (sandbox_id + ".released.json")
                if not receipt_path.exists():
                    continue  # Never act on persisted numeric process identities.
                receipt = read_record(receipt_path)
                if receipt["sandboxId"] != sandbox_id:
                    continue
                row = open_rows.get(sandbox_id)
                if row is not None and (
                    row.jobId != entry["jobId"] or row.sandboxName != entry["sandboxName"]
                ):
                    continue
                payload: dict[str, JsonValue] = {
                    "jobId": entry["jobId"],
                    "sandboxId": sandbox_id,
                    "terminatedBy": receipt["terminatedBy"],
                    "exitCode": receipt["exitCode"],
                }
                if row is not None or entry.get("releasePending"):
                    # Confirmed local death is the only recovery failure policy.
                    try:
                        self.service.fail(entry["jobId"], entry["leaseOwner"], entry["attempt"])
                    except WorkerClientError as error:
                        # A missing/invalid job must not hide confirmed sandbox death.
                        delivery_error = error
                    entry["releasePending"] = True
                    durable(journal, entry)
                    self.service.released(payload)
                    entry["releasePending"] = False
                    entry["delivered"] = True
                    durable(journal, entry)
            except WorkerClientError as error:
                delivery_error = error
            except (ValueError, KeyError, TypeError, OSError):
                continue  # A bad/foreign journal must not prevent other receipt deliveries.
        if delivery_error is not None:
            raise delivery_error
