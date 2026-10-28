"""Deterministic fixture-backed provider, prohibited in any production-like environment."""

from __future__ import annotations

import json
import os
from pathlib import Path

from netsense_runner.registry import Provider


class FakeProviderRefused(RuntimeError):
    pass


class FakeProvider(Provider):
    name = "fake"

    def __init__(self, fixture_root: Path, environment: str) -> None:
        normalized = environment.strip().lower()
        actual = os.environ.get("NETSENSE_ENV", "").strip().lower()
        if not normalized or normalized.startswith("prod") or actual.startswith("prod"):
            raise FakeProviderRefused("FAKE_PROVIDER_REFUSED")
        self._fixture_root = fixture_root.resolve()
        parts = self._fixture_root.parts
        if not any(parts[i : i + 2] == ("fixtures", "synthetic") for i in range(len(parts) - 1)):
            raise ValueError("FAKE_FIXTURE_INVALID")

    @classmethod
    def from_environment(cls, fixture_root: Path) -> "FakeProvider":
        environment = os.environ.get("NETSENSE_ENV")
        if environment is None:
            raise FakeProviderRefused("FAKE_PROVIDER_REFUSED")
        return cls(fixture_root, environment)

    def response(self, fixture_name: str) -> str:
        path = self._fixture_root / fixture_name
        if path.parent != self._fixture_root or path.suffix != ".json":
            raise ValueError("FAKE_FIXTURE_INVALID")
        if path.resolve().parent != self._fixture_root:
            raise ValueError("FAKE_FIXTURE_INVALID")
        try:
            value = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError):
            raise ValueError("FAKE_FIXTURE_INVALID") from None
        return json.dumps(value, separators=(",", ":"), sort_keys=True)
