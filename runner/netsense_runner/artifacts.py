"""Canonical immutable JSON artifacts over an explicit injected byte store."""

from __future__ import annotations

import hashlib
import json
from typing import Mapping, Protocol, cast

from pydantic import BaseModel

from netsense_runner.contract_validation import validate_contract
from netsense_runner.json_types import JsonValue


def canonical(value: object) -> bytes:
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
    ).encode("utf-8")


def digest(value: object) -> str:
    return hashlib.sha256(canonical(value)).hexdigest()


def model_value(model: BaseModel) -> dict[str, JsonValue]:
    # Pydantic models have already crossed authoritative JSON Schema validation.
    return cast(dict[str, JsonValue], model.model_dump(mode="json", by_alias=True))


def validated(contract: str, value: Mapping[str, JsonValue]) -> BaseModel:
    result = validate_contract(contract, canonical(value).decode())
    if not isinstance(result, BaseModel):
        raise ValueError("CONTRACT_INVALID")
    return result


def scoped(session_id: str, key: str) -> str:
    if (
        not key.startswith(f"sessions/{session_id}/")
        or any(part in {"", ".", ".."} for part in key.split("/"))
        or any(c in key for c in "\\%?#")
        or any(ord(c) < 32 or ord(c) == 127 for c in key)
    ):
        raise ValueError("CONTRACT_INVALID")
    return key


class ArtifactStore(Protocol):
    """Missing reads raise FileNotFoundError; put_new rejects changed existing bytes.

    Implementations must bound I/O. WorkerStorage's signed URL may be used by a
    host adapter; this boundary invents no signing or authenticated HTTP routes.
    """

    def read(self, key: str) -> bytes: ...

    def put_new(self, key: str, data: bytes, content_type: str) -> None: ...


class Artifacts:
    def __init__(self, session_id: str, store: ArtifactStore) -> None:
        self.session_id = session_id
        self.store = store

    def read(self, key: str) -> bytes:
        return self.store.read(scoped(self.session_id, key))

    def output(self, key: str, contract: str) -> BaseModel:
        raw = self.read(key)
        if len(raw) > 1_048_576:
            raise ValueError("CONTRACT_INVALID")
        return validated(contract, json.loads(raw))

    def save(self, job_id: str, run_id: str, contract: str, output: Mapping[str, JsonValue]) -> str:
        validated(contract, output)
        key = scoped(self.session_id, f"sessions/{self.session_id}/runs/{job_id}/{run_id}.json")
        self.store.put_new(key, canonical(output), "application/json")
        return key
