from __future__ import annotations

import json
from math import nan
from pathlib import Path
from typing import Callable, cast

import pytest

from netsense_runner.context import StageContext
from netsense_runner.contract_validation import validate_contract
from netsense_runner.contracts.CheckInput import CheckInput
from netsense_runner.contracts.TrackFile import TrackFile
from netsense_runner.json_types import JsonValue
from netsense_runner.rules.checker import CheckerConfig, TrackDataError, check_marks
from netsense_runner.rules.stills_routing import TrackedRemark, should_route_to_stills
from netsense_runner.stage import StageWorker
from netsense_runner.stages.s7_check import CheckRulesWorker

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "fixtures/synthetic/checker"
Modifier = Callable[[dict[str, object]], None]


def _input() -> dict[str, object]:
    return cast(dict[str, object], json.loads((FIXTURES / "check_input.json").read_text()))


def _track() -> dict[str, object]:
    return cast(dict[str, object], json.loads((FIXTURES / "track_good.json").read_text()))


def _models(
    input_data: dict[str, object] | None = None, track_data: dict[str, object] | None = None
) -> tuple[CheckInput, TrackFile]:
    source_input = _input() if input_data is None else input_data
    source_track = _track() if track_data is None else track_data
    return (
        cast(CheckInput, validate_contract("CheckInput", json.dumps(source_input))),
        cast(TrackFile, validate_contract("TrackFile", json.dumps(source_track))),
    )


def _mark(input_data: dict[str, object]) -> dict[str, object]:
    return cast(dict[str, object], cast(list[object], input_data["marks"])[0])


def _reason(input_data: dict[str, object], track_data: dict[str, object]) -> str:
    check_input, track = _models(input_data, track_data)
    return check_marks(check_input, track, CheckerConfig()).verdicts[0].reason


@pytest.mark.parametrize(
    ("name", "modify_input", "modify_track", "expected"),
    [
        ("ok", lambda value: None, lambda value: None, "ok"),
        (
            "no_player",
            lambda value: None,
            lambda value: value.update({"frames": []}),
            "no_player",
        ),
        (
            "subject_swap",
            lambda value: None,
            lambda value: value.update({"swaps": [{"ms": 500, "reason": "jump"}]}),
            "subject_swap",
        ),
        (
            "low_coverage",
            lambda value: None,
            lambda value: value.update({"fps": 4, "frames": value["frames"][:1]}),
            "low_coverage",
        ),
        (
            "outside_moment",
            lambda value: _mark(value).update({"endMs": 1001}),
            lambda value: None,
            "outside_moment",
        ),
        (
            "label_mismatch",
            lambda value: _mark(value).update({"labelText": "Altered"}),
            lambda value: None,
            "label_mismatch",
        ),
    ],
)
def test_checker_has_a_verdict_for_every_contract_reason(
    name: str,
    modify_input: Modifier,
    modify_track: Modifier,
    expected: str,
) -> None:
    input_data, track_data = _input(), _track()
    modify_input(input_data)
    modify_track(track_data)
    assert _reason(input_data, track_data) == expected


def test_boundary_threshold_and_half_open_swap_convention() -> None:
    input_data, track_data = _input(), _track()
    track_data.update({"fps": 5, "frames": cast(list[object], track_data["frames"])[:3]})
    frames = cast(list[dict[str, object]], track_data["frames"])
    frames[0]["ms"], frames[1]["ms"] = 0, 200
    assert _reason(input_data, track_data) == "low_coverage"  # 2 / 5 < 0.6
    frames.append({"ms": 400, "box": frames[0]["box"], "conf": 0.9})
    assert _reason(input_data, track_data) == "ok"  # exactly 3 / 5
    track_data["swaps"] = [{"ms": 1000, "reason": "jump"}]
    assert _reason(input_data, track_data) == "ok"  # end is exclusive


def test_sparse_unsorted_duplicate_and_gapped_frames_reduce_coverage() -> None:
    input_data, track_data = _input(), _track()
    track_data.update(
        {
            "fps": 4,
            "frames": [
                {"ms": 500, "box": {"x1": 0.1, "y1": 0.1, "x2": 0.2, "y2": 0.2}, "conf": 0.9},
                {"ms": 0, "box": {"x1": 0.1, "y1": 0.1, "x2": 0.2, "y2": 0.2}, "conf": 0.9},
                {"ms": 0, "box": {"x1": 0.1, "y1": 0.1, "x2": 0.2, "y2": 0.2}, "conf": 0.9},
                {"ms": 750, "box": {"x1": 0.1, "y1": 0.1, "x2": 0.2, "y2": 0.2}, "conf": 0.9},
            ],
            "gaps": [[500, 800]],
        }
    )
    assert _reason(input_data, track_data) == "low_coverage"  # only timestamp 0 counts, not 0 twice


def test_zero_length_and_still_tracks_are_conservative() -> None:
    input_data, track_data = _input(), _track()
    _mark(input_data).update({"endMs": 0})
    assert _reason(input_data, track_data) == "outside_moment"
    input_data, track_data = _input(), _track()
    track_data.update({"fps": 0, "frames": []})
    assert _reason(input_data, track_data) == "no_player"
    track_data["frames"] = [
        {"ms": 999, "box": {"x1": 0.1, "y1": 0.1, "x2": 0.2, "y2": 0.2}, "conf": 0.9}
    ]
    assert _reason(input_data, track_data) == "ok"


def test_invalid_track_subject_only_and_boxes_are_rejected() -> None:
    input_data, track_data = _input(), _track()
    track_data["subjectOnly"] = False
    worker = CheckRulesWorker(lambda _ref: json.dumps(track_data).encode())
    result = worker.run(cast(dict[str, JsonValue], input_data), cast(StageContext, object()))
    assert result["status"] == "failed"
    assert result["error_code"] == "SEG_BAD_INPUT"

    bad_track_data = _track()
    frames = cast(list[dict[str, object]], bad_track_data["frames"])
    frames[0]["box"] = {"x1": 0.2, "y1": 0.1, "x2": 0.1, "y2": 0.2}
    check_input, bad_track = _models(input_data, bad_track_data)
    with pytest.raises(TrackDataError):
        check_marks(check_input, bad_track, CheckerConfig())


def test_unicode_utf16_span_and_label_limit() -> None:
    input_data, track_data = _input(), _track()
    input_data["transcriptTurns"] = [{"turnId": "turn-unicode", "text": "A😀B"}]
    _mark(input_data).update(
        {
            "labelSpan": {"turnId": "turn-unicode", "start": 1, "end": 3},
            "labelText": "😀",
        }
    )
    assert _reason(input_data, track_data) == "ok"
    _mark(input_data)["labelSpan"] = {"turnId": "turn-unicode", "start": 1, "end": 2}
    assert _reason(input_data, track_data) == "label_mismatch"

    input_data, track_data = _input(), _track()
    input_data["transcriptTurns"] = [{"turnId": "turn-synthetic", "text": "😀" * 30}]
    _mark(input_data)["labelSpan"] = {"turnId": "turn-synthetic", "start": 0, "end": 60}
    _mark(input_data)["labelText"] = "😀" * 30
    assert _reason(input_data, track_data) == "ok"  # exactly 60 UTF-16 units
    input_data["transcriptTurns"] = [{"turnId": "turn-synthetic", "text": "😀" * 31}]
    _mark(input_data)["labelSpan"] = {"turnId": "turn-synthetic", "start": 0, "end": 62}
    _mark(input_data)["labelText"] = "😀" * 31
    assert _reason(input_data, track_data) == "label_too_long"


def test_wrong_turn_duplicate_turn_and_neutral_role_never_pass() -> None:
    input_data, track_data = _input(), _track()
    _mark(input_data)["labelSpan"] = {"turnId": "unknown", "start": 0, "end": 1}
    assert _reason(input_data, track_data) == "label_mismatch"

    input_data, track_data = _input(), _track()
    input_data["transcriptTurns"] = [
        {"turnId": "turn-synthetic", "text": "Keep steady"},
        {"turnId": "turn-synthetic", "text": "Keep steady"},
    ]
    check_input, track = _models(input_data, track_data)
    with pytest.raises(TrackDataError, match="DUPLICATE_TURN_ID"):
        check_marks(check_input, track, CheckerConfig())

    input_data, track_data = _input(), _track()
    _mark(input_data).update({"labelSpan": None, "neutralLabel": "Batter", "labelText": "Batter"})
    check_input, track = _models(input_data, track_data)
    assert check_marks(check_input, track, CheckerConfig(), "batter").verdicts[0].reason == "ok"
    assert (
        check_marks(check_input, track, CheckerConfig(), "bowler").verdicts[0].reason
        == "label_mismatch"
    )
    assert check_marks(check_input, track, CheckerConfig()).verdicts[0].reason == "label_mismatch"


def test_worker_validates_real_contracts_and_sanitizes_failure() -> None:
    input_data, track_data = _input(), _track()
    worker = CheckRulesWorker(lambda ref: json.dumps(track_data).encode(), subject_role="batter")
    result = worker.run(cast(dict[str, JsonValue], input_data), cast(StageContext, object()))
    assert result["status"] == "done"
    assert result["output"] is not None
    validate_contract("CheckOutput", json.dumps(result["output"]))

    secret_text = "raw synthetic transcript must not escape"
    input_data["transcriptTurns"] = [{"turnId": "turn-synthetic", "text": secret_text}]
    result = CheckRulesWorker(lambda _ref: b"not-json").run(
        cast(dict[str, JsonValue], input_data), cast(StageContext, object())
    )
    assert result["error_code"] == "SEG_BAD_INPUT"
    assert secret_text not in str(result)


def test_player_missing_status_only_when_every_mark_is_tracking_failure() -> None:
    input_data, track_data = _input(), _track()
    result = CheckRulesWorker(lambda _ref: json.dumps({**track_data, "frames": []}).encode()).run(
        cast(dict[str, JsonValue], input_data), cast(StageContext, object())
    )
    assert result["status"] == "needs_coach"
    assert result["error_code"] == "SUBJECT_NOT_FOUND"
    track_data["swaps"] = [{"ms": 20, "reason": "reassociated"}]
    result = CheckRulesWorker(lambda _ref: json.dumps(track_data).encode()).run(
        cast(dict[str, JsonValue], input_data), cast(StageContext, object())
    )
    assert result["status"] == "needs_coach"
    assert result["error_code"] == "SUBJECT_SWAP"


def test_stills_routing_excludes_notes_and_never_routes_an_empty_denominator() -> None:
    assert not should_route_to_stills(
        [TrackedRemark("note_only", "SEG_NO_TRACK"), TrackedRemark("general_note", "SEG_BAD_INPUT")]
    )
    assert should_route_to_stills(
        [TrackedRemark("tracked", "SEG_NO_TRACK"), TrackedRemark("note_only", None)], 1.0
    )
    assert not should_route_to_stills(
        [TrackedRemark("tracked", None), TrackedRemark("tracked", "SEG_BAD_INPUT")], 0.6
    )
    with pytest.raises(ValueError, match="STILLS_THRESHOLD_INVALID"):
        should_route_to_stills([], nan)


def test_neutral_label_identity_and_rendered_text_must_both_match_role() -> None:
    input_data, track_data = _input(), _track()
    _mark(input_data).update({"labelSpan": None, "neutralLabel": "Bowler", "labelText": "Batter"})
    check_input, track = _models(input_data, track_data)
    assert (
        check_marks(check_input, track, CheckerConfig(), "batter").verdicts[0].reason
        == "label_mismatch"
    )


def test_checker_conforms_to_registry_worker_protocol() -> None:
    worker: StageWorker = CheckRulesWorker(lambda _ref: json.dumps(_track()).encode())
    result = worker.run(cast(dict[str, JsonValue], _input()), ctx=cast(StageContext, object()))
    assert result["status"] == "done"
    with pytest.raises(ValueError, match="CHECKER_CONFIG_INVALID"):
        CheckerConfig(min_mark_coverage=True)
