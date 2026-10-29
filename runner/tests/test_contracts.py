import importlib
import json
from pathlib import Path
from typing import cast

import pytest
from jsonschema import Draft202012Validator
from pydantic import TypeAdapter, ValidationError
from referencing import Registry, Resource

ROOT = Path(__file__).resolve().parents[2]
SCHEMAS = {
    path.stem: json.loads(path.read_text())
    for path in (ROOT / "packages/contracts/schemas").glob("*.json")
}
REGISTRY = Registry().with_resources(
    (schema["$id"], Resource.from_contents(schema)) for schema in SCHEMAS.values()
)


@pytest.mark.parametrize("name", sorted(SCHEMAS))
def test_contract(name: str) -> None:
    schema = SCHEMAS[name]
    Draft202012Validator.check_schema(schema)
    validator = Draft202012Validator(schema, registry=REGISTRY)
    fixture = json.loads((ROOT / f"fixtures/synthetic/contracts/{name}.json").read_text())
    model = getattr(importlib.import_module(f"netsense_runner.contracts.{name}"), name)
    adapter = TypeAdapter(model)
    validator.validate(fixture["valid"])
    adapter.validate_json(json.dumps(fixture["valid"]))
    assert not validator.is_valid(fixture["invalid"])
    with pytest.raises(ValidationError):
        adapter.validate_json(json.dumps(fixture["invalid"]))
    if isinstance(fixture["valid"], dict):
        for key in schema.get("required", []):
            missing = {k: v for k, v in fixture["valid"].items() if k != key}
            assert not validator.is_valid(missing)
            with pytest.raises(ValidationError):
                adapter.validate_json(json.dumps(missing))


@pytest.mark.parametrize(
    "case",
    json.loads((ROOT / "fixtures/synthetic/contracts/negative-cases.json").read_text()),
    ids=lambda case: case["schema"] + ": " + case["label"],
)
def test_negative_boundaries(case: dict[str, object]) -> None:
    name = str(case["schema"])
    validator = Draft202012Validator(SCHEMAS[name], registry=REGISTRY)
    assert not validator.is_valid(case["value"])
    model = getattr(importlib.import_module(f"netsense_runner.contracts.{name}"), name)
    with pytest.raises(ValidationError):
        TypeAdapter(model).validate_json(json.dumps(case["value"]))


UTF16 = json.loads((ROOT / "fixtures/synthetic/contracts/utf16.json").read_text())


@pytest.mark.parametrize("case", UTF16["valid"])
def test_utf16_copy(case: dict[str, object]) -> None:
    from netsense_runner.contract_text import slice_coach_span

    assert (
        slice_coach_span(UTF16["text"], cast(int, case["start"]), cast(int, case["end"]))
        == case["expected"]
    )


@pytest.mark.parametrize("case", UTF16["invalid"])
def test_utf16_invalid(case: dict[str, object]) -> None:
    from netsense_runner.contract_text import slice_coach_span

    with pytest.raises(ValueError, match="INVALID_SPAN"):
        slice_coach_span(UTF16["text"], cast(int, case["start"]), cast(int, case["end"]))


@pytest.mark.parametrize("name", sorted(SCHEMAS))
def test_authoritative_boundary(name: str) -> None:
    from netsense_runner.contract_validation import validate_contract

    fixture = json.loads((ROOT / f"fixtures/synthetic/contracts/{name}.json").read_text())
    validate_contract(name, json.dumps(fixture["valid"]))
    with pytest.raises(ValueError, match="^CONTRACT_INVALID$"):
        validate_contract(name, json.dumps(fixture["invalid"]))


def test_boundary_rejects_unknown_contract_and_malformed_json() -> None:
    from netsense_runner.contract_validation import validate_contract

    with pytest.raises(ValueError, match="^UNKNOWN_CONTRACT$"):
        validate_contract("Missing", "{}")
    with pytest.raises(ValueError, match="^CONTRACT_INVALID$"):
        validate_contract("Subject", "{")
