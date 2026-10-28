"""Structured chat adapter. It never logs model input or raw model output."""

from __future__ import annotations

import base64
import copy
import json
from dataclasses import dataclass
from importlib.resources import files
from typing import Mapping, Protocol

from netsense_runner.contract_validation import validate_contract
from netsense_runner.json_types import JsonValue


class AgentTransport(Protocol):
    def complete(self, request: Mapping[str, JsonValue]) -> str: ...


class AgentResponseError(RuntimeError):
    """Safe error code only: raw provider text is intentionally discarded."""

    def __init__(self, error_code: str) -> None:
        super().__init__(error_code)
        self.error_code = error_code


@dataclass(frozen=True, slots=True)
class ImageInput:
    content_type: str
    data: bytes

    def as_content(self) -> dict[str, JsonValue]:
        encoded = base64.b64encode(self.data).decode("ascii")
        return {
            "type": "image_url",
            "image_url": {"url": f"data:{self.content_type};base64,{encoded}"},
        }


def bundled_schema(contract_name: str) -> dict[str, JsonValue]:
    """Inline local JSON-schema references for strict structured-output providers."""
    source = json.loads(files("netsense_runner.contracts").joinpath("schemas.json").read_text())
    root_name = contract_name + ".json"
    if root_name not in source:
        raise ValueError("UNKNOWN_CONTRACT")

    def reference_target(reference: str, origin: str) -> tuple[str, JsonValue]:
        document_name, separator, fragment = reference.partition("#")
        name = document_name.rsplit("/", 1)[-1] if document_name else origin
        document = source.get(name)
        if document is None:
            raise ValueError("SCHEMA_REFERENCE_INVALID")
        target: JsonValue = document
        if separator and fragment:
            if not fragment.startswith("/"):
                raise ValueError("SCHEMA_REFERENCE_INVALID")
            for part in fragment.removeprefix("/").split("/"):
                if not isinstance(target, dict):
                    raise ValueError("SCHEMA_REFERENCE_INVALID")
                target = target.get(part.replace("~1", "/").replace("~0", "~"))
                if target is None:
                    raise ValueError("SCHEMA_REFERENCE_INVALID")
        return name, target

    def resolve(value: JsonValue, origin: str, trail: tuple[str, ...] = ()) -> JsonValue:
        if isinstance(value, list):
            return [resolve(item, origin, trail) for item in value]
        if not isinstance(value, dict):
            return value
        reference = value.get("$ref")
        if isinstance(reference, str):
            name, target = reference_target(reference, origin)
            reference_id = f"{name}#{reference.partition('#')[2]}"
            if reference_id in trail:
                raise ValueError("SCHEMA_REFERENCE_INVALID")
            return resolve(copy.deepcopy(target), name, trail + (reference_id,))
        return {
            key: resolve(item, origin, trail)
            for key, item in value.items()
            if key != "$id"
        }

    schema = resolve(copy.deepcopy(source[root_name]), root_name, (root_name,))
    if not isinstance(schema, dict):
        raise ValueError("SCHEMA_REFERENCE_INVALID")
    return schema


def specialize_enums(
    schema: Mapping[str, JsonValue], replacements: Mapping[str, tuple[int, ...]]
) -> dict[str, JsonValue]:
    """Replace an enum at a slash-separated object path for a single model call."""
    result = copy.deepcopy(dict(schema))
    for path, enum in replacements.items():
        node: dict[str, JsonValue] = result
        for part in path.strip("/").split("/"):
            candidate = node.get(part)
            if not isinstance(candidate, dict):
                raise ValueError("SCHEMA_SPECIALIZATION_INVALID")
            node = candidate
        node["enum"] = list(enum)
    return result


class AgentAdapter:
    def __init__(self, transport: AgentTransport) -> None:
        self._transport = transport

    def complete(
        self,
        *,
        model: str,
        prompt: str,
        output_contract: str,
        images: tuple[ImageInput, ...] = (),
        enum_specializations: Mapping[str, tuple[int, ...]] | None = None,
    ) -> object:
        schema = bundled_schema(output_contract)
        if enum_specializations:
            schema = specialize_enums(schema, enum_specializations)
        content: list[JsonValue] = [{"type": "input_text", "text": prompt}]
        content.extend(image.as_content() for image in images)
        request: dict[str, JsonValue] = {
            "model": model,
            "messages": [{"role": "user", "content": content}],
            "response_format": {
                "type": "json_schema",
                "json_schema": {"name": output_contract, "schema": schema, "strict": True},
            },
        }
        try:
            response = self._transport.complete(request)
            return validate_contract(output_contract, response)
        except (ValueError, TypeError, json.JSONDecodeError):
            raise AgentResponseError("CONTRACT_INVALID") from None
