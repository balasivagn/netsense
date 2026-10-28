"""Immutable provider selection from a pinned pipeline config."""

from __future__ import annotations

from types import MappingProxyType
from typing import Mapping, Protocol


class Provider(Protocol):
    name: str


class ProviderRegistry:
    def __init__(self, providers: Mapping[str, Provider]) -> None:
        self._providers: Mapping[str, Provider] = MappingProxyType(dict(providers))

    def get(self, name: str) -> Provider:
        try:
            return self._providers[name]
        except KeyError:
            raise ValueError("PROVIDER_NOT_CONFIGURED") from None

    @property
    def names(self) -> frozenset[str]:
        return frozenset(self._providers)
