from __future__ import annotations

import threading
from pathlib import Path

import pytest

from netsense_runner.host import NoPaidLedger
from netsense_runner.host_storage import LocalArtifacts


def test_atomic_competing_artifact_writers(tmp_path: Path) -> None:
    store = LocalArtifacts(tmp_path, "session")
    key = "sessions/session/runs/job/run.json"
    barrier = threading.Barrier(2)
    results: list[str] = []

    def write(data: bytes) -> None:
        barrier.wait()
        try:
            store.put_new(key, data, "application/json")
            results.append("ok")
        except ValueError:
            results.append("conflict")

    threads = [threading.Thread(target=write, args=(value,)) for value in (b"one", b"two")]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(2)
        assert not thread.is_alive()
    assert sorted(results) == ["conflict", "ok"]
    stored = store.read(key)
    store.put_new(key, stored, "application/json")
    assert store.read(key) == stored


@pytest.mark.parametrize(
    "key",
    [
        "sessions/other/x",
        "sessions/session/../x",
        "sessions/session/%2e/x",
        "sessions/session/x?secret",
    ],
)
def test_artifacts_reject_noncanonical_keys(tmp_path: Path, key: str) -> None:
    with pytest.raises(ValueError):
        LocalArtifacts(tmp_path, "session").put_new(key, b"x", "application/json")


def test_artifacts_reject_symlinks(tmp_path: Path) -> None:
    (tmp_path / "sessions").symlink_to(tmp_path, target_is_directory=True)
    with pytest.raises(OSError):
        LocalArtifacts(tmp_path, "session").put_new(
            "sessions/session/run", b"x", "application/json"
        )


def test_fake_ledger_cannot_authorize_spend() -> None:
    assert NoPaidLedger().reserve(0, 100)
    assert not NoPaidLedger().reserve(0.001, 100)


@pytest.fixture
def media_server() -> object:
    # Real HTTP with synthetic bytes, no storage credentials or protocol mocks.
    import time
    from collections.abc import Iterator
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: object) -> None:
            pass

        def do_GET(self) -> None:
            if self.path == "/redirect":
                self.send_response(302)
                self.send_header("Location", "/ok")
                self.end_headers()
                return
            if self.path == "/stall":
                time.sleep(0.4)
                return
            if self.path == "/missing":
                self.send_response(404)
                self.end_headers()
                return
            self.send_response(200)
            self.send_header("Content-Length", "100")
            self.end_headers()
            self.wfile.write(b"x" * 100)

        def do_PUT(self) -> None:
            assert self.rfile.read(int(self.headers["Content-Length"])) == b"x" * 100
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"{}")

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    def lifecycle() -> Iterator[str]:
        try:
            yield f"http://127.0.0.1:{server.server_port}"
        finally:
            server.shutdown()
            server.server_close()
            thread.join(2)

    yield from lifecycle()


def test_media_total_deadline_bytes_redirect_expiry_and_missing(
    tmp_path: Path,
    media_server: object,
) -> None:
    import secrets
    import time

    from netsense_runner.host_storage import HttpStorage

    storage = HttpStorage(str(media_server), secrets.token_urlsafe(32), "session", tmp_path)

    def url(path: str) -> str:
        value = str(media_server) + path
        storage.expiries[value] = int((time.time() + 10) * 1000)
        return value

    assert b"".join(storage.download(url("/ok"), timeout_s=1, max_bytes=100)) == b"x" * 100
    with pytest.raises(ValueError, match="MEDIA_FAILED"):
        list(storage.download(url("/ok"), timeout_s=1, max_bytes=99))
    with pytest.raises(ValueError, match="MEDIA_FAILED"):
        list(storage.download(url("/redirect"), timeout_s=1, max_bytes=100))
    with pytest.raises(FileNotFoundError):
        list(storage.download(url("/missing"), timeout_s=1, max_bytes=100))
    start = time.monotonic()
    with pytest.raises(TimeoutError):
        list(storage.download(url("/stall"), timeout_s=0.1, max_bytes=100))
    assert time.monotonic() - start < 0.6
    expired = url("/ok")
    storage.expiries[expired] = 1
    with pytest.raises(ValueError, match="MEDIA_EXPIRED"):
        list(storage.download(expired, timeout_s=1, max_bytes=100))
    source = tmp_path / "put"
    source.write_bytes(b"x" * 100)
    storage._transfer(url("/ok"), "PUT", source, 1, 100, "application/octet-stream")
