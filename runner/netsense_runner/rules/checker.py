"""Pure Stage 7 validation rules (SPEC §7.7).

All time intervals are half-open: ``[startMs, endMs)``.  A frame or swap at
``endMs`` is therefore not part of that mark.  Frames are observations, never
an instruction to extrapolate a box into an unobserved time.
"""

from __future__ import annotations

from dataclasses import dataclass
from math import ceil, isfinite
from typing import Literal

from netsense_runner.adapters.rules import RulesAdapter, SubjectRole
from netsense_runner.contract_text import slice_coach_span
from netsense_runner.contracts.CheckInput import CheckInput, Mark
from netsense_runner.contracts.CheckOutput import CheckOutput, Verdict
from netsense_runner.contracts.TrackFile import Frame, TrackFile

VerdictReason = Literal[
    "ok",
    "no_player",
    "subject_swap",
    "low_coverage",
    "outside_moment",
    "label_mismatch",
    "label_too_long",
]


class TrackDataError(ValueError):
    """The track cannot safely be used to identify the selected person."""


@dataclass(frozen=True, slots=True)
class CheckerConfig:
    min_mark_coverage: float = 0.6
    label_max_utf16_units: int = 60

    def __post_init__(self) -> None:
        if (
            isinstance(self.min_mark_coverage, bool)
            or not isfinite(self.min_mark_coverage)
            or self.min_mark_coverage < 0
            or self.min_mark_coverage > 1
        ):
            raise ValueError("CHECKER_CONFIG_INVALID")
        if type(self.label_max_utf16_units) is not int or self.label_max_utf16_units < 1:
            raise ValueError("CHECKER_CONFIG_INVALID")


def check_marks(
    input_value: CheckInput,
    track: TrackFile,
    config: CheckerConfig,
    subject_role: SubjectRole | None = None,
) -> CheckOutput:
    """Return contract-shaped verdicts without changing any coach text.

    A positive-fps track has ``ceil(mark_duration * fps / 1000)`` expected
    observations.  Only distinct, valid frame timestamps inside the mark count;
    duplicates and frames declared in a gap do not.  A still track (fps == 0)
    has one expected observation and needs one valid frame inside the mark.
    """
    _validate_track(track)
    turns = _turns_by_id(input_value)
    verdicts = [
        _check_mark(mark, input_value, track, turns, config, subject_role)
        for mark in input_value.marks
    ]
    missing = {"no_player", "subject_swap", "low_coverage"}
    player_missing = bool(verdicts) and all(verdict.reason in missing for verdict in verdicts)
    return CheckOutput(
        remarkId=input_value.remarkId,
        verdicts=verdicts,
        remarkStatus="player_missing" if player_missing else "ok",
    )


def _turns_by_id(input_value: CheckInput) -> dict[str, str]:
    turns: dict[str, str] = {}
    for turn in input_value.transcriptTurns:
        if turn.turnId in turns:
            raise TrackDataError("DUPLICATE_TURN_ID")
        turns[turn.turnId] = turn.text
    return turns


def _check_mark(
    mark: Mark,
    input_value: CheckInput,
    track: TrackFile,
    turns: dict[str, str],
    config: CheckerConfig,
    subject_role: SubjectRole | None,
) -> Verdict:
    if not _inside(mark.startMs, mark.endMs, input_value.momentStartMs, input_value.momentEndMs):
        return _verdict(mark.markId, "outside_moment")
    label_reason = _label_reason(mark, turns, config, subject_role)
    if label_reason is not None:
        return _verdict(mark.markId, label_reason)
    if not track.frames:
        return _verdict(mark.markId, "no_player")
    if any(_inside(swap.ms, swap.ms + 1, mark.startMs, mark.endMs) for swap in track.swaps):
        return _verdict(mark.markId, "subject_swap")
    if _coverage(mark.startMs, mark.endMs, track) < config.min_mark_coverage:
        return _verdict(mark.markId, "low_coverage")
    return _verdict(mark.markId, "ok")


def _verdict(mark_id: str, reason: VerdictReason) -> Verdict:
    return Verdict(markId=mark_id, **{"pass": reason == "ok"}, reason=reason)


def _inside(start_ms: int, end_ms: int, container_start_ms: int, container_end_ms: int) -> bool:
    return start_ms >= container_start_ms and end_ms <= container_end_ms and start_ms < end_ms


def _label_reason(
    mark: Mark,
    turns: dict[str, str],
    config: CheckerConfig,
    subject_role: SubjectRole | None,
) -> VerdictReason | None:
    if _utf16_units(mark.labelText) > config.label_max_utf16_units:
        return "label_too_long"
    if mark.neutralLabel is not None:
        if subject_role is None or mark.labelSpan is not None:
            return "label_mismatch"
        expected_neutral = RulesAdapter.neutral_label(subject_role)
        return (
            None
            if mark.neutralLabel == expected_neutral and mark.labelText == expected_neutral
            else "label_mismatch"
        )
    if mark.labelSpan is None:
        return "label_mismatch"
    text = turns.get(mark.labelSpan.turnId)
    if text is None:
        return "label_mismatch"
    try:
        expected = slice_coach_span(text, mark.labelSpan.start, mark.labelSpan.end)
    except ValueError:
        return "label_mismatch"
    return None if mark.labelText.encode("utf-8") == expected.encode("utf-8") else "label_mismatch"


def _utf16_units(value: str) -> int:
    return len(value.encode("utf-16-le")) // 2


def _coverage(start_ms: int, end_ms: int, track: TrackFile) -> float:
    expected = 1 if track.fps == 0 else ceil((end_ms - start_ms) * track.fps / 1000)
    if expected < 1:
        return 0.0
    observed = {
        frame.ms
        for frame in track.frames
        if _inside(frame.ms, frame.ms + 1, start_ms, end_ms) and not _in_gap(frame.ms, track)
    }
    return min(len(observed), expected) / expected


def _in_gap(timestamp_ms: int, track: TrackFile) -> bool:
    return any(gap.root[0].root <= timestamp_ms < gap.root[1].root for gap in track.gaps)


def _validate_track(track: TrackFile) -> None:
    if not isfinite(track.fps) or track.fps < 0:
        raise TrackDataError("TRACK_INVALID")
    for gap in track.gaps:
        start_ms, end_ms = gap.root[0].root, gap.root[1].root
        if start_ms >= end_ms:
            raise TrackDataError("TRACK_INVALID")
    for frame in track.frames:
        _validate_frame(frame)


def _validate_frame(frame: Frame) -> None:
    box = frame.box
    values = (box.x1, box.y1, box.x2, box.y2, frame.conf)
    if not all(isfinite(value) for value in values):
        raise TrackDataError("TRACK_INVALID")
    if box.x1 >= box.x2 or box.y1 >= box.y2:
        raise TrackDataError("TRACK_INVALID")
