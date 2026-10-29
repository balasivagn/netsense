"""Authoritative JSON Schema validation followed by generated Pydantic parsing."""

import importlib
import json
from importlib.resources import files
from typing import cast

from jsonschema import Draft202012Validator
from pydantic import TypeAdapter, ValidationError
from referencing import Registry, Resource

_SCHEMAS = json.loads(files("netsense_runner.contracts").joinpath("schemas.json").read_text())
_REGISTRY = Registry().with_resources(
    (name, Resource.from_contents(schema)) for name, schema in _SCHEMAS.items()
)


def validate_contract(name: str, payload: str) -> object:
    """Reject invalid JSON without exposing its contents in error messages.

    JSON Schema remains authoritative for record-key patterns and uniqueItems,
    which the upstream Pydantic generator does not fully encode.
    """
    schema = _SCHEMAS.get(name + ".json")
    if schema is None:
        raise ValueError("UNKNOWN_CONTRACT")
    try:
        value = json.loads(payload)
        if not Draft202012Validator(schema, registry=_REGISTRY).is_valid(value):
            raise ValueError("CONTRACT_INVALID")
        model = getattr(importlib.import_module(f"netsense_runner.contracts.{name}"), name)
        return cast(object, TypeAdapter(model).validate_json(payload))
    except (json.JSONDecodeError, ValidationError):
        raise ValueError("CONTRACT_INVALID") from None
