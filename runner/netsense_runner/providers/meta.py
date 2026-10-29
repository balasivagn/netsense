"""UNTESTED Meta configuration holder; transports are injected by callers."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class MetaProvider:
    base_url: str
    api_key: str
    name: str = "meta"
