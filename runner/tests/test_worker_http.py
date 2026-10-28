from __future__ import annotations

import json
import threading
import time
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import ClassVar, TypeVar
from uuid import uuid4

import pytest
from pydantic import BaseModel

from netsense_runner.clients.convex_worker import ConvexWorkerClient, WorkerClientError
from netsense_runner.contracts.CheckOutput import CheckOutput
from netsense_runner.contracts.MomentOutput import MomentOutput
from netsense_runner.contracts.PlaceOutput import PlaceOutput
from netsense_runner.contracts.PlanOutput import PlanOutput
from netsense_runner.contracts.Provenance import Provenance
from netsense_runner.contracts.RenderOutput import RenderOutput
from netsense_runner.contracts.SubjectAnchorOutput import SubjectAnchorOutput
from netsense_runner.contracts.TrackOutput import TrackOutput
from netsense_runner.contracts.TranscodeOutput import TranscodeOutput
from netsense_runner.contracts.TranscribeOutput import TranscribeOutput

ROOT = Path(__file__).resolve().parents[2]
TOKEN = uuid4().hex


def fixture(name: str) -> dict[str, object]:
    value = json.loads((ROOT / "fixtures/synthetic" / name).read_text())
    if not isinstance(value, dict):
        raise ValueError("synthetic fixture must be an object")
    result: dict[str, object] = {}
    for key, item in value.items():
        if not isinstance(key, str):
            raise ValueError("synthetic fixture key must be a string")
        result[key] = item
    return result


_M = TypeVar("_M", bound=BaseModel)


def output(name: str, model: type[_M]) -> _M:
    return model.model_validate(fixture(f"contracts/{name}.json")["valid"])


class Handler(BaseHTTPRequestHandler):
    calls: ClassVar[list[tuple[str, dict[str, object], str | None]]] = []
    redirect: ClassVar[bool] = False
    responder: ClassVar[Callable[[str, dict[str, object]], tuple[int, bytes]]] = staticmethod(
        lambda _path, _body: (200, b'{"ok":true}')
    )

    def log_message(self, format: str, *args: object) -> None:
        pass

    def do_GET(self) -> None:
        self.serve({})

    def do_POST(self) -> None:
        self.serve(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))

    def serve(self, body: dict[str, object]) -> None:
        type(self).calls.append((self.path, body, self.headers.get("Authorization")))
        if type(self).redirect:
            self.send_response(302)
            self.send_header("Location", "/captured")
            self.end_headers()
            return
        status, raw = type(self).responder(self.path, body)
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


@pytest.fixture
def server() -> Iterator[tuple[str, type[Handler]]]:
    Handler.calls = []
    Handler.redirect = False
    Handler.responder = staticmethod(lambda _path, _body: (200, b'{"ok":true}'))
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    httpd.daemon_threads = False
    thread = threading.Thread(target=httpd.serve_forever)
    thread.start()
    try:
        yield f"http://127.0.0.1:{httpd.server_port}", Handler
    finally:
        httpd.shutdown()
        thread.join(timeout=2)
        httpd.server_close()


def client(
    url: str,
    *,
    timeout_s: float = 20.0,
    max_response_bytes: int = 32_768,
) -> ConvexWorkerClient:
    return ConvexWorkerClient(
        url,
        TOKEN,
        timeout_s=timeout_s,
        max_response_bytes=max_response_bytes,
    )


def test_get_job_maps_projection_and_strict_response(server: tuple[str, type[Handler]]) -> None:
    url, handler = server
    payload = fixture("worker_http/job-projection.json")
    payload["config"] = fixture("contracts/PipelineConfig.json")["valid"]
    handler.responder = staticmethod(lambda _path, _body: (200, json.dumps(payload).encode()))
    result = client(url).get_job()
    assert result.session.studentLabel == "synthetic student"
    assert result.session.subjectRole == "batter"
    assert result.inputs.uploadId == "synthetic-upload"
    assert handler.calls == [("/worker/job", {}, f"Bearer {TOKEN}")]
    handler.responder = staticmethod(lambda _path, _body: (200, b'{"ok":true,"extra":1}'))
    with pytest.raises(WorkerClientError, match="^INVALID_RESPONSE$"):
        client(url).heartbeat()


def test_all_routes_and_omitted_optionals(server: tuple[str, type[Handler]]) -> None:
    url, handler = server
    handler.responder = staticmethod(
        lambda path, _body: (
            (200, b'{"stageRunId":"synthetic-stage-run"}')
            if path == "/worker/stageRuns/start"
            else (
                200,
                b'{"ok":true,"annotationIds":[{"markId":"synthetic","annotationId":"synthetic-annotation"}]}',
            )
            if path == "/worker/persist/marks"
            else (200, b'{"ok":true}')
        )
    )
    c = client(url)
    c.heartbeat()
    assert (
        c.start_stage(
            stage="transcode",
            worker_id="worker",
            attempt=1,
            idempotency_key="a" * 64,
            input_hash="b" * 64,
        )
        == "synthetic-stage-run"
    )
    c.finish_stage(
        stage_run_id="synthetic-stage-run",
        status="done",
        sam_frames=0,
        input_tokens=0,
        output_tokens=0,
        cost_usd=0.0,
        output_ref="sessions/synthetic-session/output",
    )
    c.done(status="waiting_for_coach")
    c.persist_transcode("synthetic-stage-run", output("TranscodeOutput", TranscodeOutput))
    c.persist_turns("synthetic-stage-run", output("TranscribeOutput", TranscribeOutput))
    c.persist_plan("synthetic-stage-run", output("PlanOutput", PlanOutput))
    c.persist_moment("synthetic-stage-run", output("MomentOutput", MomentOutput))
    c.persist_target("synthetic-stage-run", output("SubjectAnchorOutput", SubjectAnchorOutput))
    c.persist_track("synthetic-stage-run", output("TrackOutput", TrackOutput), cache_key="a" * 64)
    mapping = c.persist_marks(
        "synthetic-stage-run",
        output("PlaceOutput", PlaceOutput),
        provenance=output("Provenance", Provenance),
    )
    c.persist_verdicts("synthetic-stage-run", output("CheckOutput", CheckOutput))
    c.persist_render("synthetic-stage-run", output("RenderOutput", RenderOutput))
    assert mapping == {"synthetic": "synthetic-annotation"}
    assert [path for path, _body, _auth in handler.calls] == [
        "/worker/heartbeat",
        "/worker/stageRuns/start",
        "/worker/stageRuns/finish",
        "/worker/done",
        "/worker/persist/transcode",
        "/worker/persist/turns",
        "/worker/persist/plan",
        "/worker/persist/moment",
        "/worker/persist/target",
        "/worker/persist/track",
        "/worker/persist/marks",
        "/worker/persist/verdicts",
        "/worker/persist/render",
    ]
    assert all(auth == f"Bearer {TOKEN}" for _path, _body, auth in handler.calls)
    assert "remarkId" not in handler.calls[1][1]
    assert "errorCode" not in handler.calls[3][1]
    assert handler.calls[9][1]["cacheKey"] == "a" * 64
    assert "provenance" in handler.calls[10][1]


def test_refuses_invalid_output_before_network(server: tuple[str, type[Handler]]) -> None:
    url, handler = server
    c = client(url)
    invalid = output("TrackOutput", TrackOutput).model_copy(update={"coverage": float("nan")})
    with pytest.raises(WorkerClientError, match="^CONTRACT_INVALID$"):
        c.persist_track("synthetic-stage-run", invalid, cache_key="a" * 64)
    with pytest.raises(WorkerClientError, match="^CONTRACT_INVALID$"):
        c.persist_track(
            "synthetic-stage-run", output("TrackOutput", TrackOutput), cache_key="A" * 64
        )
    assert handler.calls == []


@pytest.mark.parametrize("response", [b"{", b"\xff", b'{"ok":false}', b'{"ok":true,"x":1}'])
def test_safe_status_and_malformed_responses(
    server: tuple[str, type[Handler]], response: bytes
) -> None:
    url, handler = server
    handler.responder = staticmethod(
        lambda _path, _body: (500 if response == b"{" else 200, response)
    )
    with pytest.raises(WorkerClientError) as error:
        client(url).heartbeat()
    assert str(error.value) in {"HTTP_STATUS", "INVALID_RESPONSE"}
    assert TOKEN not in repr(error.value)


def test_limits_timeout_redirect_and_concurrency(server: tuple[str, type[Handler]]) -> None:
    url, handler = server
    handler.responder = staticmethod(lambda _path, _body: (200, b"{" + b" " * 100 + b"}"))
    with pytest.raises(WorkerClientError, match="^RESPONSE_TOO_LARGE$"):
        client(url, max_response_bytes=16).heartbeat()

    class SlowHandler(Handler):
        def serve(self, body: dict[str, object]) -> None:
            self.send_response(200)
            self.end_headers()
            for piece in (b"{", b'"ok":', b"true", b"}"):
                try:
                    self.wfile.write(piece)
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    return
                time.sleep(0.04)

    slow = ThreadingHTTPServer(("127.0.0.1", 0), SlowHandler)
    slow.daemon_threads = False
    thread = threading.Thread(target=slow.serve_forever)
    thread.start()
    try:
        with pytest.raises(WorkerClientError, match="^TIMEOUT$"):
            client(f"http://127.0.0.1:{slow.server_port}", timeout_s=0.08).heartbeat()
    finally:
        slow.shutdown()
        thread.join(timeout=2)
        slow.server_close()

    handler.redirect = True
    with pytest.raises(WorkerClientError, match="^REDIRECT_REJECTED$"):
        client(url).heartbeat()
    assert [path for path, _body, _auth in handler.calls] == [
        "/worker/heartbeat",
        "/worker/heartbeat",
    ]
    handler.redirect = False

    entered = threading.Event()
    release = threading.Event()

    payload = fixture("worker_http/job-projection.json")
    payload["config"] = fixture("contracts/PipelineConfig.json")["valid"]

    def delayed(path: str, _body: dict[str, object]) -> tuple[int, bytes]:
        if path == "/worker/job":
            entered.set()
            release.wait(timeout=1)
            return 200, json.dumps(payload).encode()
        return 200, b'{"ok":true}'

    handler.responder = delayed
    shared = client(url)
    with ThreadPoolExecutor(max_workers=1) as pool:
        blocked = pool.submit(shared.get_job)
        try:
            assert entered.wait(timeout=1)
            started = time.monotonic()
            shared.heartbeat()
            assert time.monotonic() - started < 0.5
            assert not blocked.done()
        finally:
            release.set()
        assert blocked.result(timeout=1).job.id



@pytest.mark.parametrize("origin", ["https://x/path", "https://x?y=1", "https://u:p@x", "ftp://x"])
def test_origin_and_timeout_validation(origin: str) -> None:
    with pytest.raises(ValueError):
        ConvexWorkerClient(origin, TOKEN)
    with pytest.raises(ValueError):
        ConvexWorkerClient("http://localhost", TOKEN, timeout_s=float("inf"))


def test_rejects_wrong_upload_nesting_role_and_anchor_shape(
    server: tuple[str, type[Handler]],
) -> None:
    url, handler = server
    for change in ("upload", "role", "box", "extra", "missing", "nonfinite"):
        payload = fixture("worker_http/job-projection.json")
        payload["config"] = fixture("contracts/PipelineConfig.json")["valid"]
        session = payload["session"]
        inputs = payload["inputs"]
        assert isinstance(session, dict) and isinstance(inputs, dict)
        if change == "upload":
            inputs["upload"] = {
                k: inputs.pop(k)
                for k in ("uploadId", "sourceKey", "declaredBytes", "declaredSha256", "mimeType")
            }
        elif change == "role":
            session["subjectRole"] = None
        elif change == "box":
            session["subjectAnchor"] = {
                "box": {"arbitrary": 1},
                "frameMs": 0,
                "referenceCropKey": "sessions/synthetic-session/crop.jpg",
            }
        elif change == "extra":
            session["unknown"] = True
        elif change == "missing":
            del session["subject"]
        else:
            session["durationMs"] = float("inf")
        handler.responder = staticmethod(lambda _path, _body: (200, json.dumps(payload).encode()))
        with pytest.raises(WorkerClientError, match="^INVALID_RESPONSE$"):
            client(url).get_job()


def test_rejects_bad_lifecycle_inputs_and_provenance_before_network(
    server: tuple[str, type[Handler]],
) -> None:
    url, handler = server
    c = client(url)
    for attempt in (0, -1, True):
        with pytest.raises(WorkerClientError, match="^CONTRACT_INVALID$"):
            c.start_stage(
                stage="plan",
                worker_id="worker",
                attempt=attempt,
                idempotency_key="a" * 64,
                input_hash="b" * 64,
            )
    with pytest.raises(WorkerClientError, match="^CONTRACT_INVALID$"):
        c.start_stage(
            stage="plan",
            worker_id="worker",
            attempt=1,
            idempotency_key="short",
            input_hash="b" * 64,
        )
    for cost in (-1.0, float("nan"), float("inf")):
        with pytest.raises(WorkerClientError, match="^CONTRACT_INVALID$"):
            c.finish_stage(
                stage_run_id="synthetic-run",
                status="failed",
                sam_frames=0,
                input_tokens=0,
                output_tokens=0,
                cost_usd=cost,
            )
    with pytest.raises(WorkerClientError, match="^CONTRACT_INVALID$"):
        c.done(status="failed", error_code="unknown")
    provenance = output("Provenance", Provenance).model_copy(
        update={"stageRunIds": {"unknown": "x"}}
    )
    with pytest.raises(WorkerClientError, match="^CONTRACT_INVALID$"):
        c.persist_marks("synthetic-run", output("PlaceOutput", PlaceOutput), provenance=provenance)
    assert handler.calls == []


def test_ok_requires_boolean_true(server: tuple[str, type[Handler]]) -> None:
    url, handler = server
    handler.responder = staticmethod(lambda _path, _body: (200, b'{"ok":1}'))
    with pytest.raises(WorkerClientError, match="^INVALID_RESPONSE$"):
        client(url).heartbeat()
