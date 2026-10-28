from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import cast

import pytest

from netsense_runner.budget import Budget, BudgetExceeded
from netsense_runner.contracts.PipelineConfig import Limits, PipelineConfig
from netsense_runner.registry import ProviderRegistry

ROOT = Path(__file__).resolve().parents[2]


class LockedLedger:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.total = 0.0

    def reserve(self, amount_usd: float, daily_limit_usd: float) -> bool:
        with self.lock:
            if self.total + amount_usd > daily_limit_usd:
                return False
            self.total += amount_usd
            return True


def limits() -> Limits:
    config_path = ROOT / "config/pipeline_config.v1.json"
    config = PipelineConfig.model_validate(json.loads(config_path.read_text()))
    return config.limits


def test_budget_concurrent_reservations_cannot_exceed_pinned_cap() -> None:
    budget = Budget(limits(), LockedLedger())
    errors: list[str] = []

    def reserve() -> None:
        try:
            budget.reserve_sam_frames(1000)
        except BudgetExceeded as error:
            errors.append(error.error_code)

    threads = [threading.Thread(target=reserve) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert budget.usage.sam_frames == 6000
    assert errors == ["BUDGET_SAM_FRAMES", "BUDGET_SAM_FRAMES"]


def test_budget_cache_hits_do_not_charge_and_daily_preflight_is_atomic() -> None:
    ledger = LockedLedger()
    budget = Budget(limits(), ledger)
    budget.reserve_sam_frames(7000, cache_hit=True)
    budget.reserve_spark_tokens(500000, 1, cache_hit=True)
    assert budget.usage.sam_frames == 0
    budget.reserve_spend(10)
    with pytest.raises(BudgetExceeded, match="BUDGET_DAILY"):
        budget.reserve_spend(6)
    assert budget.usage.reserved_usd == 10


@pytest.mark.parametrize("invalid", [float("nan"), float("inf"), -1.0, True])
def test_budget_rejects_invalid_usage_before_charging(invalid: float) -> None:
    ledger = LockedLedger()
    budget = Budget(limits(), ledger)
    with pytest.raises(ValueError):
        budget.reserve_spend(invalid)
    with pytest.raises(ValueError):
        budget.reserve_sam_frames(cast(int, invalid))
    with pytest.raises(ValueError):
        budget.reserve_spark_tokens(cast(int, invalid), 0)
    assert budget.usage.reserved_usd == 0
    assert budget.usage.sam_frames == budget.usage.spark_tokens == 0
    assert ledger.total == 0


def test_budget_keeps_a_private_copy_of_pinned_limits() -> None:
    pinned = limits()
    budget = Budget(pinned, LockedLedger())
    cap = pinned.jobSamFrameCap
    pinned.jobSamFrameCap = cap + 100
    with pytest.raises(BudgetExceeded):
        budget.reserve_sam_frames(cap + 1)


class TestProvider:
    name = "test"


def test_registry_copies_input_mapping_and_rejects_unknown_provider() -> None:
    mapping = {"test": TestProvider()}
    registry = ProviderRegistry(mapping)
    mapping.clear()
    assert registry.get("test").name == "test"
    with pytest.raises(ValueError, match="PROVIDER_NOT_CONFIGURED"):
        registry.get("unknown")
