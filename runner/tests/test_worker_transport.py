"""Deadline and cleanup regressions using synthetic, ephemeral local transports."""
from __future__ import annotations

import json
import subprocess
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import cast
from uuid import uuid4

import pytest

from netsense_runner.clients.convex_worker import ConvexWorkerClient, WorkerClientError
from netsense_runner.clients.worker_wire import OkResponse


@contextmanager
def serving(mode: str, location: str = "") -> Iterator[tuple[str, list[str]]]:
    stop = threading.Event()
    calls: list[str] = []
    errors: list[BaseException] = []

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.0"

        def log_message(self, format: str, *args: object) -> None:
            pass

        def do_POST(self) -> None:
            self.do_GET()

        def do_GET(self) -> None:
            calls.append(self.path)
            try:
                if mode == "headers":
                    self.connection.sendall(b"HTTP/1.0 200 OK\r\nX-Synthetic: ")
                    for _ in range(30):
                        self.connection.sendall(b"x")
                        if stop.wait(0.04):
                            return
                    self.connection.sendall(b"\r\n\r\n")
                    return
                self.send_response(302 if mode == "redirect" else 200)
                if mode == "redirect":
                    self.send_header("Location", location)
                if mode == "false-length":
                    self.send_header("Content-Length", "999999")
                self.end_headers()
                if mode == "stall":
                    stop.wait(1.2)
                elif mode == "trickle":
                    for _ in range(30):
                        self.wfile.write(b" ")
                        self.wfile.flush()
                        if stop.wait(0.04):
                            return
                elif mode in {"large", "false-length"}:
                    self.wfile.write(b" " * 65536)
                else:
                    self.wfile.write(b'{"ok":true}')
            except (BrokenPipeError, ConnectionResetError):
                pass  # Expected peer cancellation; all other handler errors fail below.
            except BaseException as error:
                errors.append(error)

    class Server(ThreadingHTTPServer):
        daemon_threads = False

    server = Server(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01})
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", calls
    finally:
        stop.set()
        server.shutdown()
        thread.join(2)
        server.server_close()  # Joins every request handler.
        assert not thread.is_alive()
        assert errors == []


@pytest.mark.parametrize("mode", ["trickle", "headers", "stall"])
def test_total_network_deadline(mode: str) -> None:
    with serving(mode) as (url, calls):
        c = ConvexWorkerClient(url, uuid4().hex, timeout_s=0.2)
        started = time.monotonic()
        with pytest.raises(WorkerClientError, match="^TIMEOUT$"):
            c.heartbeat()
        elapsed = time.monotonic() - started
        assert 0.17 <= elapsed < 0.5
        assert calls == ["/worker/heartbeat"]


@pytest.mark.parametrize("seam", ["getaddrinfo", "connect"])
def test_cancels_and_reaps_blocked_platform_work(
    monkeypatch: pytest.MonkeyPatch, seam: str
) -> None:
    original = subprocess.Popen
    children: list[subprocess.Popen[bytes]] = []

    def launch(args: list[str], **kwargs: object) -> subprocess.Popen[bytes]:
        helper = args[-1]
        patch = (
            "socket.getaddrinfo = lambda *a, **k: time.sleep(30)"
            if seam == "getaddrinfo"
            else "socket.socket.connect = lambda *a, **k: time.sleep(30)"
        )
        script = (
            f"import socket,time,runpy; {patch}; "
            f"runpy.run_path({helper!r},run_name='__main__')"
        )
        child = cast(
            "subprocess.Popen[bytes]",
            original([args[0], "-c", script], **kwargs),  # type: ignore[call-overload]
        )
        children.append(child)
        return child

    monkeypatch.setattr(subprocess, "Popen", launch)
    c = ConvexWorkerClient("http://127.0.0.1:1", uuid4().hex, timeout_s=0.15)
    for _ in range(3):
        started = time.monotonic()
        with pytest.raises(WorkerClientError, match="^TIMEOUT$"):
            c.heartbeat()
        assert time.monotonic() - started < 0.45
        assert all(child.poll() is not None for child in children)
        assert all(child.stdin is not None and child.stdin.closed for child in children)
        assert all(child.stdout is not None and child.stdout.closed for child in children)


@pytest.mark.parametrize("mode", ["large", "false-length"])
def test_stream_cap_without_trusting_content_length(mode: str) -> None:
    with serving(mode) as (url, _):
        with pytest.raises(WorkerClientError, match="^RESPONSE_TOO_LARGE$"):
            ConvexWorkerClient(url, uuid4().hex, max_response_bytes=1024).heartbeat()


def test_redirect_never_reaches_cross_origin_and_proxies_are_ignored(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with serving("ok") as (capture, captured):
        monkeypatch.setenv("http_proxy", capture)
        monkeypatch.setenv("HTTP_PROXY", capture)
        monkeypatch.setenv("ALL_PROXY", capture)
        monkeypatch.setenv("NO_PROXY", "")
        with serving("redirect", capture) as (url, calls):
            with pytest.raises(WorkerClientError, match="^REDIRECT_REJECTED$"):
                ConvexWorkerClient(url, uuid4().hex).heartbeat()
            assert calls == ["/worker/heartbeat"]
        assert captured == []


@pytest.mark.parametrize("origin", [
    "http://:80", "http://x:bad", "http://x:65536", "http://x:0", "http://x:",
    "http://[::1", "http://[::1]junk", "http://x%20y", "http://u:p@x", "http://x/a", "http://x?", "http://x#",
    " http://x", "http://x\n", "http://x\t", "http://x\\y",
])
def test_origin_errors_are_fixed(origin: str) -> None:
    with pytest.raises(ValueError, match="^INVALID_ORIGIN$"):
        ConvexWorkerClient(origin, uuid4().hex)


@pytest.mark.parametrize(
    "value", [True, False, 0, -1, float("nan"), float("inf"), 10**1000, "x", None],
)
def test_timeout_validation(value: object) -> None:
    with pytest.raises(ValueError, match="^INVALID_TIMEOUT$"):
        ConvexWorkerClient("http://localhost", uuid4().hex, timeout_s=value)  # type: ignore[arg-type]


@pytest.mark.parametrize("value", [True, 0, -1, 1.5, float("nan"), 1048577, "x", None])
def test_limit_validation(value: object) -> None:
    with pytest.raises(ValueError, match="^INVALID_RESPONSE_LIMIT$"):
        ConvexWorkerClient(
            "http://localhost", uuid4().hex, max_response_bytes=value,  # type: ignore[arg-type]
        )


@pytest.mark.parametrize("suffix", ["\r\n", "\x00", "é", " ", "\x7f"])
def test_invalid_tokens_are_never_reflected(suffix: str) -> None:
    token = uuid4().hex + suffix
    with pytest.raises(ValueError, match="^INVALID_TOKEN$") as error:
        ConvexWorkerClient("http://localhost", token)
    assert token not in repr(error.value)
    with pytest.raises(ValueError, match="^INVALID_TOKEN$"):
        ConvexWorkerClient("http://localhost", "")
    c = ConvexWorkerClient("http://localhost", uuid4().hex)
    assert c.runtime_site_url not in repr(c) and c.job_token not in repr(c)


def test_large_legitimate_job_projection() -> None:
    from test_worker_http import fixture

    # Reuse the full reviewed wire fixture, only extending synthetic turn text.
    payload = fixture("worker_http/job-projection.json")
    payload["config"] = fixture("contracts/PipelineConfig.json")["valid"]
    inputs = payload["inputs"]
    assert isinstance(inputs, dict)
    transcript = fixture("contracts/TranscribeOutput.json")["valid"]
    assert isinstance(transcript, dict)
    turns = transcript["turns"]
    assert isinstance(turns, list) and turns
    turns[0]["text"] *= 5000
    turns[0]["correctedText"] = None
    inputs["transcriptTurns"] = turns
    raw = json.dumps(payload).encode()
    assert 32768 < len(raw) < 1048576
    # Dedicated handler so the fixture keeps all server thread ownership local.
    class Projection(BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: object) -> None:
            pass

        def do_GET(self) -> None:
            self.send_response(200)
            self.end_headers()
            self.wfile.write(raw)

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Projection)
    httpd.daemon_threads = False
    thread = threading.Thread(target=httpd.serve_forever, kwargs={"poll_interval": 0.01})
    thread.start()
    try:
        c = ConvexWorkerClient(f"http://127.0.0.1:{httpd.server_port}", uuid4().hex)
        assert c.get_job().inputs.transcriptTurns[0].text == turns[0]["text"]
    finally:
        httpd.shutdown()
        thread.join(2)
        httpd.server_close()


def test_request_caps_and_serialization_are_pre_network() -> None:
    c = ConvexWorkerClient("http://127.0.0.1:1", uuid4().hex)
    for path, size in [("/worker/heartbeat", 32768), ("/worker/persist/turns", 1048576)]:
        with pytest.raises(WorkerClientError, match="^REQUEST_TOO_LARGE$"):
            c._request("POST", path, {"text": "x" * size}, OkResponse)
    with pytest.raises(WorkerClientError, match="^CONTRACT_INVALID$"):
        c._request("POST", "/worker/heartbeat", {"value": float("nan")}, OkResponse)


@pytest.mark.parametrize("exception", ["HTTPException", "InvalidURL", "ValueError"])
def test_transport_exception_cannot_reflect_authorization(
    monkeypatch: pytest.MonkeyPatch, exception: str,
) -> None:
    original = subprocess.Popen

    def launch(args: list[str], **kwargs: object) -> subprocess.Popen[bytes]:
        helper = args[-1]
        error = f"http.client.{exception}" if exception != "ValueError" else "ValueError"
        script = (
            "import http.client,runpy; "
            "http.client.HTTPConnection.request = lambda *a, **k: "
            f"(_ for _ in ()).throw({error}(k['headers']['Authorization'])); "
            f"runpy.run_path({helper!r},run_name='__main__')"
        )
        return cast(
            "subprocess.Popen[bytes]",
            original([args[0], "-c", script], **kwargs),  # type: ignore[call-overload]
        )

    monkeypatch.setattr(subprocess, "Popen", launch)
    token = uuid4().hex
    with pytest.raises(WorkerClientError, match="^TRANSPORT_FAILED$") as error:
        ConvexWorkerClient("http://127.0.0.1:1", token).heartbeat()
    assert token not in repr(error.value)


def test_caller_cancellation_kills_and_reaps_owned_process(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    original = subprocess.Popen
    children: list[subprocess.Popen[bytes]] = []

    def launch(args: list[str], **kwargs: object) -> subprocess.Popen[bytes]:
        child = cast(
            "subprocess.Popen[bytes]",
            original(args, **kwargs),  # type: ignore[call-overload]
        )
        children.append(child)
        communicate = child.communicate
        interrupted = False

        def interrupt_once(
            input: bytes | None = None, timeout: float | None = None,
        ) -> tuple[bytes, bytes]:
            nonlocal interrupted
            if not interrupted:
                interrupted = True
                raise KeyboardInterrupt
            return communicate(input, timeout)

        monkeypatch.setattr(child, "communicate", interrupt_once)
        return child

    monkeypatch.setattr(subprocess, "Popen", launch)
    with pytest.raises(KeyboardInterrupt):
        ConvexWorkerClient("http://127.0.0.1:1", uuid4().hex).heartbeat()
    assert len(children) == 1 and children[0].poll() is not None
    assert children[0].stdin is not None and children[0].stdin.closed
    assert children[0].stdout is not None and children[0].stdout.closed
