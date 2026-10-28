"""Contract-isolated Stage 7 local rules worker."""

from __future__ import annotations

import json
from collections.abc import Callable, Mapping
from typing import Literal, cast

from netsense_runner.adapters.rules import SubjectRole
from netsense_runner.context import StageContext
from netsense_runner.contract_validation import validate_contract
from netsense_runner.contracts.CheckInput import CheckInput
from netsense_runner.contracts.TrackFile import TrackFile
from netsense_runner.json_types import JsonValue
from netsense_runner.rules.checker import CheckerConfig, check_marks
from netsense_runner.stage import StageResult, Usage

TrackFileLoader = Callable[[str], bytes]


class CheckRulesWorker:
    """Load one validated track file and apply deterministic stage-7 rules.

    ``subject_role`` is session data supplied by the parent runner, not inferred
    from remarks.  It is optional because frozen ``CheckInput`` has no role; if
    omitted, neutral labels are rejected rather than guessing a role.
    """

    id: str = "check.rules@1"
    stage: Literal["check"] = "check"
    worker_type: Literal["rules"] = "rules"
    input_contract: str = "CheckInput"
    output_contract: str = "CheckOutput"

    def __init__(
        self,
        track_file_loader: TrackFileLoader,
        config: CheckerConfig | None = None,
        subject_role: SubjectRole | None = None,
    ) -> None:
        self._track_file_loader = track_file_loader
        self._config = config or CheckerConfig()
        self._subject_role = subject_role

    def run(self, input_value: Mapping[str, JsonValue], _ctx: StageContext) -> StageResult:
        try:
            check_input = cast(CheckInput, validate_contract("CheckInput", json.dumps(input_value)))
        except (TypeError, ValueError):
            return _failure("CONTRACT_INVALID")
        try:
            track = _load_track(self._track_file_loader, check_input.trackFileRef)
            output = check_marks(check_input, track, self._config, self._subject_role)
        except Exception:  # Loader and contract boundaries must not expose raw inputs.
            return _failure("SEG_BAD_INPUT")
        output_value = cast(dict[str, JsonValue], output.model_dump(by_alias=True))
        try:
            validate_contract("CheckOutput", json.dumps(output_value))
        except ValueError:
            return _failure("CONTRACT_INVALID")
        if output.remarkStatus != "player_missing":
            return _success(output_value)
        error_code = (
            "SUBJECT_SWAP"
            if any(verdict.reason == "subject_swap" for verdict in output.verdicts)
            else "SUBJECT_NOT_FOUND"
        )
        return {
            "status": "needs_coach",
            "output": output_value,
            "error_code": error_code,
            "usage": _usage(),
            "cost_usd": 0.0,
            "trace": None,
        }


def _load_track(loader: TrackFileLoader, file_ref: str) -> TrackFile:
    raw = loader(file_ref)
    text = raw.decode("utf-8")
    return cast(TrackFile, validate_contract("TrackFile", text))


def _usage() -> Usage:
    return {"samFrames": 0, "inputTokens": 0, "outputTokens": 0, "audioSeconds": 0}


def _success(output: dict[str, JsonValue]) -> StageResult:
    return {
        "status": "done",
        "output": output,
        "error_code": None,
        "usage": _usage(),
        "cost_usd": 0.0,
        "trace": None,
    }


def _failure(error_code: str) -> StageResult:
    return {
        "status": "failed",
        "output": None,
        "error_code": error_code,
        "usage": _usage(),
        "cost_usd": 0.0,
        "trace": None,
    }
