"""Pure session-level stills routing (SPEC §7.7)."""

from __future__ import annotations

from dataclasses import dataclass
from math import isfinite
from typing import Literal, Sequence


@dataclass(frozen=True, slots=True)
class TrackedRemark:
    """The minimal stage-5 result needed by a future DAG join.

    ``kind`` keeps note-only and general notes out of the tracked denominator.
    """

    kind: Literal["tracked", "note_only", "general_note"]
    error_code: str | None


def should_route_to_stills(remarks: Sequence[TrackedRemark], stills_threshold: float = 0.5) -> bool:
    """Whether failed track share requires the screen-15 route.

    This does not choose still rendering or mutate configuration; it only
    reports the session-level routing condition for the runner.
    """
    if not isfinite(stills_threshold) or not 0 <= stills_threshold <= 1:
        raise ValueError("STILLS_THRESHOLD_INVALID")
    tracked = [remark for remark in remarks if remark.kind == "tracked"]
    if not tracked:
        return False
    failed = sum(remark.error_code in {"SEG_NO_TRACK", "SEG_BAD_INPUT"} for remark in tracked)
    return failed / len(tracked) >= stills_threshold
