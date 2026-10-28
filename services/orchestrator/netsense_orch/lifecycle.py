"""Sequential local lifecycle with durable release delivery and no automatic requeue."""

from __future__ import annotations

import json
import os
from pathlib import Path
from uuid import uuid4

from netsense_orch.drivers import LocalDriver, LocalSandboxSpec, LocalSandboxWaitTimeout
from netsense_orch.service import Claim, Service
from netsense_runner.json_types import JsonValue

# This is the entire child environment. Never forward the parent environment.
CHILD_ENV = frozenset(
    {
        "PATH",
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
    temp = path.with_suffix(".tmp")
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


class Lifecycle:
    def __init__(self, service: Service, root: Path, python: str, cwd: Path) -> None:
        self.service, self.root, self.python, self.cwd = service, root, python, cwd
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.owner = "local-" + uuid4().hex
        self.driver = LocalDriver()

    def run(self, claim: Claim) -> None:
        env = {key: value for key, value in os.environ.items() if key in CHILD_ENV}
        env["NETSENSE_JOB_TOKEN"] = claim.jobToken
        gate = self.root / (uuid4().hex + ".start")
        env["NETSENSE_RUNNER_START_FILE"] = str(gate.resolve())
        name = "netsense-" + claim.job.id + "-" + str(claim.job.attempt)
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
                    },
                )
                self.service.sandbox(claim, handle_id, name)
                durable(gate, {"sandboxId": handle_id})
                while True:
                    try:
                        result = handle.wait(0.2)
                        if result != 0:
                            self.service.fail(claim.job.id, self.owner, claim.job.attempt)
                        break
                    except LocalSandboxWaitTimeout:
                        stale = self.service.stale()
                        if any(
                            row.job_id == claim.job.id
                            and row.leaseOwner == self.owner
                            and row.attempt == claim.job.attempt
                            for row in stale
                        ):
                            self.service.fail(
                                claim.job.id, self.owner, claim.job.attempt, stale=True
                            )
                            break
        except Exception:
            self.service.fail(claim.job.id, self.owner, claim.job.attempt)
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
        open_rows = {row.sandboxId: row for row in self.service.open()}
        stale_rows = self.service.stale()
        for stale in stale_rows:
            if stale.leaseOwner:
                self.service.fail(stale.job_id, stale.leaseOwner, stale.attempt, stale=True)
        for journal in self.root.glob("*.job.json"):
            entry = json.loads(journal.read_text())
            receipt_path = self.root / (str(entry["sandboxId"]) + ".released.json")
            if not receipt_path.exists():
                continue  # Never act on persisted numeric process identities.
            receipt = json.loads(receipt_path.read_text())
            if receipt["sandboxId"] != entry["sandboxId"]:
                continue
            # Retry precisely the same release tuple after a lost HTTP response.
            payload: dict[str, JsonValue] = {
                "jobId": entry["jobId"],
                "sandboxId": entry["sandboxId"],
                "terminatedBy": receipt["terminatedBy"],
                "exitCode": receipt["exitCode"],
            }
            if entry["sandboxId"] in open_rows or entry.get("releasePending"):
                entry["releasePending"] = True
                durable(journal, entry)
                self.service.released(payload)
                entry["releasePending"] = False
                entry["delivered"] = True
                durable(journal, entry)
