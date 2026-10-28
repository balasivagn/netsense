"""Thread-safe local budget reservations for a single pinned job configuration."""

from __future__ import annotations

from dataclasses import dataclass
from math import isfinite
from threading import Lock
from typing import Protocol

from netsense_runner.contracts.PipelineConfig import Limits


class BudgetExceeded(RuntimeError):
    def __init__(self, error_code: str) -> None:
        super().__init__(error_code)
        self.error_code = error_code


class DailySpendLedger(Protocol):
    """Atomic preflight/reservation supplied by the orchestrator in a later lane."""

    def reserve(self, amount_usd: float, daily_limit_usd: float) -> bool: ...


@dataclass(frozen=True, slots=True)
class BudgetUsage:
    sam_frames: int
    spark_tokens: int
    reserved_usd: float


class Budget:
    def __init__(self, limits: Limits, daily_ledger: DailySpendLedger) -> None:
        self._limits = limits.model_copy(deep=True)
        self._daily_ledger = daily_ledger
        self._lock = Lock()
        self._sam_frames = 0
        self._spark_tokens = 0
        self._reserved_usd = 0.0

    def reserve_sam_frames(self, frames: int, *, cache_hit: bool = False) -> None:
        if type(frames) is not int or frames < 0:
            raise ValueError("frames must be non-negative")
        if cache_hit:
            return
        with self._lock:
            if self._sam_frames + frames > self._limits.jobSamFrameCap:
                raise BudgetExceeded("BUDGET_SAM_FRAMES")
            self._sam_frames += frames

    def reserve_spark_tokens(
        self, input_tokens: int, output_tokens: int, *, cache_hit: bool = False
    ) -> None:
        if (
            type(input_tokens) is not int
            or type(output_tokens) is not int
            or input_tokens < 0
            or output_tokens < 0
        ):
            raise ValueError("tokens must be non-negative")
        if cache_hit:
            return
        tokens = input_tokens + output_tokens
        with self._lock:
            if self._spark_tokens + tokens > self._limits.jobSparkTokenCap:
                raise BudgetExceeded("BUDGET_TOKENS")
            self._spark_tokens += tokens

    def reserve_spend(self, amount_usd: float, *, cache_hit: bool = False) -> None:
        if isinstance(amount_usd, bool) or not isfinite(amount_usd) or amount_usd < 0:
            raise ValueError("amount_usd must be non-negative")
        if cache_hit or amount_usd == 0:
            return
        with self._lock:
            if not self._daily_ledger.reserve(amount_usd, self._limits.dailySpendLimitUsd):
                raise BudgetExceeded("BUDGET_DAILY")
            self._reserved_usd += amount_usd

    @property
    def usage(self) -> BudgetUsage:
        with self._lock:
            return BudgetUsage(self._sam_frames, self._spark_tokens, self._reserved_usd)
