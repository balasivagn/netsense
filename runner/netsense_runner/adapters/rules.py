"""Deterministic, side-effect-free rules helpers."""

from __future__ import annotations

from typing import Literal

SubjectRole = Literal["batter", "bowler", "other"]


class RulesAdapter:
    @staticmethod
    def neutral_label(role: SubjectRole) -> str:
        return {"batter": "Batter", "bowler": "Bowler", "other": "Player"}[role]

    @staticmethod
    def is_stills_required(failed_tracks: int, tracked_remarks: int, threshold: float) -> bool:
        return tracked_remarks > 0 and failed_tracks / tracked_remarks >= threshold

    @staticmethod
    def swap_suspected(previous_iou: float, centre_jump_fraction: float, elapsed_ms: int) -> bool:
        return previous_iou < 0.1 and centre_jump_fraction > 0.25 and elapsed_ms <= 200
