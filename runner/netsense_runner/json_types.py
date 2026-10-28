"""The only permissive boundary type used for JSON crossing a worker boundary."""

from __future__ import annotations

from typing import TypeAlias

JsonPrimitive: TypeAlias = str | int | float | bool | None
JsonValue: TypeAlias = JsonPrimitive | list["JsonValue"] | dict[str, "JsonValue"]
