from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Iterator, Mapping, cast

import pytest

from netsense_runner.adapters.agent import (
    AgentAdapter,
    AgentResponseError,
    ImageInput,
    bundled_schema,
    specialize_enums,
)
from netsense_runner.adapters.model_api import ModelApiAdapter, TranscriptionRequest
from netsense_runner.adapters.rules import RulesAdapter
from netsense_runner.adapters.tool import ToolAdapter, ToolExecutionError
from netsense_runner.contracts.MomentModelOutput import MomentModelOutput
from netsense_runner.providers.fake import FakeProvider, FakeProviderRefused
from netsense_runner.providers.gemini_stub import GeminiStub, NotConfigured

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "fixtures/synthetic/adapters"


class RecordedAgentTransport:
    def __init__(self, response: str) -> None:
        self.request: Mapping[str, object] | None = None
        self.response = response

    def complete(self, request: Mapping[str, object]) -> str:
        self.request = request
        return self.response


def test_agent_adapter_sends_strict_schema_and_data_url() -> None:
    response = (FIXTURES / "MomentModelOutput.json").read_text()
    transport = RecordedAgentTransport(response)
    result = AgentAdapter(transport).complete(
        model="configured-model",
        prompt="fixture instruction",
        output_contract="MomentModelOutput",
        images=(ImageInput("image/jpeg", b"\x00\x01"),),
        enum_specializations={"/properties/startIdx": (0, 1)},
    )
    assert isinstance(result, MomentModelOutput)
    assert result.startIdx == 0
    assert transport.request is not None
    assert transport.request["model"] == "configured-model"
    messages = cast(list[dict[str, object]], transport.request["messages"])
    message = messages[0]
    assert message == {
        "role": "user",
        "content": [
            {"type": "text", "text": "fixture instruction"},
            {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,AAE="}},
        ],
    }
    response_format = cast(dict[str, object], transport.request["response_format"])
    assert response_format["type"] == "json_schema"
    json_schema = cast(dict[str, object], response_format["json_schema"])
    assert json_schema["name"] == "MomentModelOutput"
    assert json_schema["strict"] is True
    schema = cast(dict[str, object], json_schema["schema"])
    properties = cast(dict[str, dict[str, object]], schema["properties"])
    assert properties["startIdx"]["enum"] == [0, 1]


def test_agent_adapter_rejects_invalid_model_contract_without_raw_response() -> None:
    transport = RecordedAgentTransport('{"unexpected":true}')
    with pytest.raises(AgentResponseError, match="CONTRACT_INVALID"):
        AgentAdapter(transport).complete(
            model="configured-model", prompt="fixture", output_contract="MomentModelOutput"
        )


def test_agent_enforces_the_specialized_schema_on_the_response() -> None:
    response = (FIXTURES / "MomentModelOutput.json").read_text()
    with pytest.raises(AgentResponseError, match="CONTRACT_INVALID"):
        AgentAdapter(RecordedAgentTransport(response)).complete(
            model="configured-model",
            prompt="fixture",
            output_contract="MomentModelOutput",
            enum_specializations={"/properties/startIdx": (1,)},
        )


def test_string_enums_can_be_narrowed_but_not_broadened() -> None:
    schema = bundled_schema("MomentModelOutput")
    narrowed = specialize_enums(schema, {"/properties/confidence": ("high",)})
    assert narrowed != schema
    with pytest.raises(ValueError, match="SCHEMA_SPECIALIZATION_INVALID"):
        specialize_enums(schema, {"/properties/confidence": ("invalid",)})
    with pytest.raises(ValueError, match="SCHEMA_SPECIALIZATION_INVALID"):
        specialize_enums(schema, {"/properties/confidence": ()})


def test_agent_system_preamble_and_transport_error_do_not_leak() -> None:
    response = (FIXTURES / "MomentModelOutput.json").read_text()
    transport = RecordedAgentTransport(response)
    AgentAdapter(transport).complete(
        model="configured-model",
        prompt="fixture",
        output_contract="MomentModelOutput",
        system_prompt="fixture instruction",
    )
    assert transport.request is not None
    assert transport.request["temperature"] == 0.2
    messages = cast(list[dict[str, object]], transport.request["messages"])
    assert messages[0] == {"role": "system", "content": "fixture instruction"}

    class FailingTransport:
        def complete(self, request: Mapping[str, object]) -> str:
            raise RuntimeError(response)

    with pytest.raises(AgentResponseError) as raised:
        AgentAdapter(FailingTransport()).complete(
            model="configured-model", prompt="fixture", output_contract="MomentModelOutput"
        )
    assert str(raised.value) == "INFRA_NETWORK"


def test_agent_schema_bundles_cross_file_references() -> None:
    def contains_reference(value: object) -> bool:
        if isinstance(value, dict):
            return "$ref" in value or any(contains_reference(child) for child in value.values())
        if isinstance(value, list):
            return any(contains_reference(child) for child in value)
        return False

    assert not contains_reference(bundled_schema("PlaceModelOutput"))


class RecordedModelTransport:
    def __init__(self) -> None:
        self.multipart: tuple[str, Mapping[str, str], bytes, str] | None = None
        self.stream_payload: Mapping[str, object] | None = None

    def post_multipart(
        self, path: str, fields: Mapping[str, str], file_bytes: bytes, filename: str
    ) -> str:
        self.multipart = (path, fields, file_bytes, filename)
        return "{}"

    def post_json_stream(self, path: str, payload: Mapping[str, object]) -> Iterator[str]:
        assert path == "/v1/responses"
        self.stream_payload = payload
        return iter(("event",))


def test_model_api_adapter_uses_injectable_nonchat_transports() -> None:
    transport = RecordedModelTransport()
    adapter = ModelApiAdapter(transport)
    assert (
        adapter.transcribe(
            TranscriptionRequest("voice", ("one",), ("English",), b"wav", "chunk.wav")
        )
        == "{}"
    )
    expected_request = json.dumps(
        {
            "mode": "DIARIZATION",
            "model": "voice",
            "audioEncoding": "WAV",
            "keywords": ["one"],
            "languageBias": ["English"],
        }
    )
    assert transport.multipart == (
        "/asr/transcribe",
        {"request": expected_request},
        b"wav",
        "chunk.wav",
    )
    assert list(adapter.responses_stream("sam", [{"type": "input_video"}])) == ["event"]
    assert transport.stream_payload == {
        "model": "sam",
        "stream": True,
        "input": [{"type": "input_video"}],
    }


@pytest.mark.parametrize("environment", ["prod", "PROD", "Production", "  prod-preview  ", ""])
def test_fake_provider_refuses_production_like_environments(environment: str) -> None:
    with pytest.raises(FakeProviderRefused):
        FakeProvider(FIXTURES, environment)


def test_fake_provider_requires_explicit_nonproduction_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("NETSENSE_ENV", raising=False)
    with pytest.raises(FakeProviderRefused):
        FakeProvider.from_environment(FIXTURES)
    provider = FakeProvider(FIXTURES, "test")
    assert json.loads(provider.response("MomentModelOutput.json"))["confidence"] == "high"


def test_fake_constructor_cannot_override_production_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("NETSENSE_ENV", "prod")
    with pytest.raises(FakeProviderRefused):
        FakeProvider(FIXTURES, "test")


def test_fake_provider_rejects_nonfixture_root_and_symlink_escape(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="FAKE_FIXTURE_INVALID"):
        FakeProvider(tmp_path, "test")
    root = tmp_path / "fixtures" / "synthetic" / "adapters"
    root.mkdir(parents=True)
    (root / "escape.json").symlink_to(FIXTURES / "MomentModelOutput.json")
    with pytest.raises(ValueError, match="FAKE_FIXTURE_INVALID"):
        FakeProvider(root, "test").response("escape.json")


def test_gemini_stub_is_not_configured() -> None:
    with pytest.raises(NotConfigured, match="GEMINI_NOT_CONFIGURED"):
        GeminiStub().complete()


def test_tool_timeout_kills_subprocess_group() -> None:
    with pytest.raises(ToolExecutionError, match="STAGE_TIMEOUT"):
        ToolAdapter().run((sys.executable, "-c", "import time; time.sleep(5)"), timeout_s=0.01)


def test_tool_failure_scrubs_url_and_cleanup_returns() -> None:
    with pytest.raises(ToolExecutionError) as raised:
        script = (
            "import sys; "
            "sys.stderr.write('https://hidden.invalid/?token=x plain-error'); sys.exit(2)"
        )
        ToolAdapter().run(
            (
                sys.executable,
                "-c",
                script,
            ),
            timeout_s=1,
        )
    assert "hidden.invalid" not in " ".join(raised.value.__notes__)
    assert ToolAdapter().run((sys.executable, "-c", "print('ok')"), timeout_s=1).stdout == b"ok\n"


def test_tool_redacts_plain_text_not_just_urls() -> None:
    script = "import pathlib,sys;sys.stderr.write(pathlib.Path(sys.argv[1]).read_text())"
    result = ToolAdapter().run(
        (sys.executable, "-c", script, str(FIXTURES / "MomentModelOutput.json")),
        timeout_s=1,
    )
    assert result.stderr == "TOOL_STDERR_REDACTED"


def test_tool_cancellation_also_reaps_the_child(monkeypatch: pytest.MonkeyPatch) -> None:
    spawned: list[subprocess.Popen[bytes]] = []

    def interrupted(
        process: subprocess.Popen[bytes],
        input: bytes | None = None,
        timeout: float | None = None,
    ) -> tuple[bytes, bytes]:
        spawned.append(process)
        raise KeyboardInterrupt

    monkeypatch.setattr(subprocess.Popen, "communicate", interrupted)
    with pytest.raises(KeyboardInterrupt):
        ToolAdapter().run((sys.executable, "-c", "import time;time.sleep(30)"), timeout_s=1)
    assert len(spawned) == 1
    assert spawned[0].poll() is not None


def test_rules_are_deterministic() -> None:
    rules = RulesAdapter()
    assert rules.neutral_label("other") == "Player"
    assert rules.is_stills_required(1, 2, 0.5)
    assert rules.swap_suspected(0.09, 0.26, 200)
