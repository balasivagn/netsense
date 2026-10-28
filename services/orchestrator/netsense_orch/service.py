"""Documented private service wires over the bounded owned worker transport."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, RootModel

from netsense_runner.clients.convex_worker import ConvexWorkerClient
from netsense_runner.clients.worker_wire import JobWire, OkResponse
from netsense_runner.contract_base import ContractModel
from netsense_runner.contracts.PipelineConfig import PipelineConfig
from netsense_runner.json_types import JsonValue


class Claim(ContractModel):
    job: JobWire
    config: PipelineConfig
    jobToken: str = Field(repr=False)
    timeoutS: int


class ClaimResponse(RootModel[Claim | None]):
    pass


class StaleJob(BaseModel):
    id: str | None = None
    # Existing stale/open endpoints return internal document fields.
    model_config = {"populate_by_name": True}
    job_id: str = Field(alias="_id")
    leaseOwner: str | None = None
    attempt: int


class OpenSandbox(BaseModel):
    jobId: str
    sandboxId: str
    sandboxName: str
    driver: str


class StaleResponse(RootModel[list[StaleJob]]):
    pass


class OpenResponse(RootModel[list[OpenSandbox]]):
    pass


class ControlResponse(ContractModel):
    decision: Literal["continue", "stopped", "terminal", "superseded", "missing"]


class Service:
    def __init__(self, origin: str, secret: str) -> None:
        self.origin = origin
        self.transport = ConvexWorkerClient(origin, secret, timeout_s=5)

    def claim(self, owner: str) -> Claim | None:
        return self.transport._request(
            "POST", "/svc/jobs/claim", {"leaseOwner": owner}, ClaimResponse
        ).root

    def sandbox(self, claim: Claim, sandbox_id: str, name: str) -> None:
        self.transport._request(
            "POST",
            "/svc/jobs/sandbox",
            {
                "jobId": claim.job.id,
                "sandboxId": sandbox_id,
                "sandboxName": name,
                "driver": "local",
                "leaseOwner": claim.job.leaseOwner,
                "expectedAttempt": claim.job.attempt,
            },
            OkResponse,
        )

    def released(self, payload: dict[str, JsonValue]) -> None:
        self.transport._request("POST", "/svc/jobs/released", payload, OkResponse)

    def fail(self, job_id: str, owner: str, attempt: int, *, stale: bool = False) -> None:
        self.transport._request(
            "POST",
            "/svc/jobs/fail",
            {
                "jobId": job_id,
                "leaseOwner": owner,
                "expectedAttempt": attempt,
                "staleOnly": stale,
                "errorCode": "INFRA_EXEC",
            },
            OkResponse,
        )

    def control(self, job_id: str, owner: str, attempt: int) -> ControlResponse:
        return self.transport._request(
            "POST",
            "/svc/jobs/control",
            {"jobId": job_id, "leaseOwner": owner, "expectedAttempt": attempt},
            ControlResponse,
        )

    def stale(self) -> list[StaleJob]:
        return self.transport._request("GET", "/svc/jobs/stale", None, StaleResponse).root

    def open(self) -> list[OpenSandbox]:
        return self.transport._request("GET", "/svc/sandboxes/open", None, OpenResponse).root
