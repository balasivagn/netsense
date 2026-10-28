"""Development host capabilities: signed HTTP media and owned immutable local artifacts.

The root must be the VM's trusted local storage directory on a local filesystem.
This is not an isolation boundary against hostile code sharing the host UID.
"""

from __future__ import annotations

import fcntl
import json
import math
import os
import re
import stat
import subprocess
import sys
import tempfile
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit
from uuid import uuid4

from netsense_runner.artifacts import scoped
from netsense_runner.clients.convex_worker import ConvexWorkerClient
from netsense_runner.contract_base import ContractModel
from netsense_runner.json_types import JsonValue


class SignedUrl(ContractModel):
    op: Literal["get", "put"]
    key: str
    url: str
    expiresAt: int


class SignedResponse(ContractModel):
    urls: list[SignedUrl]


class LocalArtifacts:
    def __init__(self, root: Path, session: str) -> None:
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", session):
            raise ValueError("INVALID_SESSION")
        self.root, self.session = root, session
        self.deadline = threading.local()
        self.cache_observations: dict[str, os.stat_result] = {}

    def _check_deadline(self) -> None:
        end = getattr(self.deadline, "value", None)
        if end is not None and time.monotonic() >= end:
            raise TimeoutError("ARTIFACT_TIMEOUT")

    @contextmanager
    def _parent(self, key: str) -> Iterator[tuple[int, str]]:
        self._check_deadline()
        scoped(self.session, key)
        if not re.fullmatch(r"[A-Za-z0-9_./;-]+", key):
            raise ValueError("INVALID_KEY")
        fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            for part in key.split("/")[:-1]:
                try:
                    os.mkdir(part, mode=0o700, dir_fd=fd)
                except FileExistsError:
                    pass
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.close(fd)
                fd = child
            yield fd, key.rsplit("/", 1)[1]
        finally:
            os.close(fd)

    def exists(self, key: str, *, deadline: float) -> bool:
        if time.monotonic() >= deadline:
            raise TimeoutError("MEDIA_TIMEOUT")
        try:
            with self._parent(key) as (fd, name):
                file = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                try:
                    observed = os.fstat(file)
                    self.cache_observations[key] = observed
                    if not stat.S_ISREG(observed.st_mode):
                        raise ValueError("INVALID_ARTIFACT")
                finally:
                    os.close(file)
            if time.monotonic() >= deadline:
                raise TimeoutError("MEDIA_TIMEOUT")
            return True
        except FileNotFoundError:
            return False

    def reject_cache(self, key: str) -> None:
        # Only renderer-validated corrupt derived media, never immutable JSON.
        if not re.fullmatch(r"sessions/[^/]+/renders/(preview|final)/[^/]+-[a-f0-9]{64}\.mp4", key):
            raise ValueError("INVALID_CACHE_KEY")
        observed = self.cache_observations.pop(key, None)
        if observed is None:
            raise ValueError("CACHE_NOT_OBSERVED")
        with self._parent(key) as (fd, name):
            fcntl.flock(fd, fcntl.LOCK_EX)
            try:
                current = os.stat(name, dir_fd=fd, follow_symlinks=False)
            except FileNotFoundError:
                return
            if not stat.S_ISREG(current.st_mode) or (
                current.st_dev,
                current.st_ino,
                current.st_size,
                current.st_mtime_ns,
            ) != (observed.st_dev, observed.st_ino, observed.st_size, observed.st_mtime_ns):
                raise ValueError("CACHE_CHANGED")
            # Preserve evidence; new publication remains atomic and replay-checked.
            os.rename(name, ".corrupt-" + uuid4().hex, src_dir_fd=fd, dst_dir_fd=fd)
            os.fsync(fd)

    def read(self, key: str) -> bytes:
        with self._parent(key) as (fd, name):
            file = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
            with os.fdopen(file, "rb") as source:
                if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
                    raise ValueError("INVALID_ARTIFACT")
                if os.fstat(source.fileno()).st_size > 1048576:
                    raise ValueError("ARTIFACT_TOO_LARGE")
                data = source.read(1048576 + 1)
                self._check_deadline()
                if len(data) > 1048576:
                    raise ValueError("ARTIFACT_TOO_LARGE")
                return data

    def put_new(self, key: str, data: bytes, content_type: str) -> None:
        if len(data) > 1048576:
            raise ValueError("ARTIFACT_TOO_LARGE")
        with self._parent(key) as (fd, name):
            temp = ".write-" + uuid4().hex
            try:
                file = os.open(temp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600, dir_fd=fd)
                with os.fdopen(file, "wb") as output:
                    output.write(data)
                    output.flush()
                    os.fsync(output.fileno())
                try:
                    os.link(temp, name, src_dir_fd=fd, dst_dir_fd=fd, follow_symlinks=False)
                except FileExistsError:
                    existing = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                    with os.fdopen(existing, "rb") as source:
                        if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
                            raise ValueError("INVALID_ARTIFACT")
                        if source.read(len(data) + 1) != data:
                            raise ValueError("IMMUTABLE_ARTIFACT") from None
                os.fsync(fd)
            finally:
                os.unlink(temp, dir_fd=fd)

    def put_path(self, key: str, path: Path, *, deadline: float) -> None:
        if time.monotonic() >= deadline:
            raise TimeoutError("ARTIFACT_LIMIT")
        with self._parent(key) as (fd, name):
            temp = ".write-" + uuid4().hex
            try:
                file = os.open(temp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600, dir_fd=fd)
                with os.fdopen(file, "wb") as output, path.open("rb") as source:
                    total = 0
                    while chunk := source.read(65536):
                        total += len(chunk)
                        if time.monotonic() >= deadline or total > 2 * 1024**3:
                            raise TimeoutError("ARTIFACT_LIMIT")
                        output.write(chunk)
                    output.flush()
                    os.fsync(output.fileno())
                try:
                    os.link(temp, name, src_dir_fd=fd, dst_dir_fd=fd, follow_symlinks=False)
                except FileExistsError:
                    existing = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                    with os.fdopen(existing, "rb") as a, path.open("rb") as b:
                        if not stat.S_ISREG(os.fstat(a.fileno()).st_mode):
                            raise ValueError("INVALID_ARTIFACT")
                        while True:
                            if time.monotonic() >= deadline:
                                raise TimeoutError("ARTIFACT_LIMIT")
                            first, second = a.read(65536), b.read(65536)
                            if first != second:
                                raise ValueError("IMMUTABLE_ARTIFACT")
                            if not first:
                                break
                os.fsync(fd)
            finally:
                os.unlink(temp, dir_fd=fd)


class HttpStorage:
    def __init__(
        self,
        origin: str,
        token: str,
        session: str,
        scratch: Path,
        artifacts: LocalArtifacts | None = None,
    ) -> None:
        self.signer = ConvexWorkerClient(origin, token, timeout_s=10)
        self.session, self.scratch = session, scratch
        self.artifacts = artifacts
        scratch.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.expiries: dict[str, int] = {}
        self.deadline = threading.local()
        if artifacts is not None:
            artifacts.deadline = self.deadline

    def remaining(self, default: float) -> float:
        end = getattr(self.deadline, "value", None)
        remaining = default if end is None else min(default, end - time.monotonic())
        if remaining <= 0:
            raise TimeoutError("MEDIA_TIMEOUT")
        return remaining

    def _sign(
        self,
        key: str,
        op: Literal["get", "put"],
        content_type: str | None = None,
        *,
        timeout_s: float = 10,
    ) -> str:
        scoped(self.session, key)
        operation: dict[str, JsonValue] = {"op": op, "key": key}
        if content_type is not None:
            operation["contentType"] = content_type
        response = ConvexWorkerClient(
            self.signer.runtime_site_url, self.signer.job_token, timeout_s=self.remaining(timeout_s)
        )._request("POST", "/api/worker/sign", {"ops": [operation]}, SignedResponse)
        if len(response.urls) != 1:
            raise ValueError("SIGN_FAILED")
        signed = response.urls[0]
        parsed = urlsplit(signed.url)
        if (
            signed.op != op
            or signed.key != key
            or signed.expiresAt <= time.time() * 1000
            or parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username
            or parsed.password
            or parsed.fragment
            or any(ord(c) < 33 or ord(c) > 126 for c in signed.url)
        ):
            raise ValueError("SIGN_FAILED")
        self.expiries[signed.url] = signed.expiresAt
        return signed.url

    def get_url(self, key: str) -> str:
        return self._sign(key, "get")

    def _transfer(
        self,
        url: str,
        method: str,
        path: Path,
        timeout_s: float,
        max_bytes: int,
        content_type: str = "",
    ) -> None:
        remaining = (self.expiries.get(url, 0) - time.time() * 1000) / 1000
        timeout = min(self.remaining(timeout_s), remaining)
        if not math.isfinite(timeout) or timeout <= 0 or max_bytes < 1:
            raise ValueError("MEDIA_EXPIRED")
        process = subprocess.Popen(
            [sys.executable, "-I", str(Path(__file__).with_name("host_media.py"))],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
        try:
            output, _ = process.communicate(
                json.dumps([url, method, str(path), content_type, timeout, max_bytes]).encode(),
                timeout=timeout,
            )
            if output.strip() == b"MISSING":
                raise FileNotFoundError("MEDIA_MISSING")
            if process.returncode != 0 or output.strip() != b"OK":
                raise ValueError("MEDIA_FAILED")
        except subprocess.TimeoutExpired:
            raise TimeoutError("MEDIA_TIMEOUT") from None
        finally:
            if process.returncode is None:
                process.kill()
            process.wait()
            for pipe in (process.stdin, process.stdout):
                if pipe is not None:
                    pipe.close()

    def download(self, url: str, *, timeout_s: float, max_bytes: int) -> Iterator[bytes]:
        with tempfile.TemporaryDirectory(dir=self.scratch) as temp:
            path = Path(temp) / "media"
            deadline = time.monotonic() + self.remaining(timeout_s)
            self._transfer(url, "GET", path, timeout_s, max_bytes)
            with path.open("rb") as source:
                while chunk := source.read(65536):
                    if time.monotonic() >= deadline:
                        raise TimeoutError("MEDIA_TIMEOUT")
                    yield chunk

    def load(self, key: str, *, timeout_s: float = 20, max_bytes: int = 1048576) -> bytes:
        deadline = time.monotonic() + self.remaining(timeout_s)
        url = self._sign(key, "get", timeout_s=timeout_s)
        return b"".join(
            self.download(url, timeout_s=deadline - time.monotonic(), max_bytes=max_bytes)
        )

    def exists(self, key: str, *, timeout_s: float) -> bool:
        deadline = time.monotonic() + self.remaining(timeout_s)
        if self.artifacts is not None:
            # Trusted scoped local metadata boundary; missing signing is not a GET URL.
            return self.artifacts.exists(key, deadline=deadline)
        try:
            url = self._sign(key, "get", timeout_s=timeout_s)
            # Bounded lookup by GET; full media validation remains the renderer's job.
            for _ in self.download(
                url, timeout_s=deadline - time.monotonic(), max_bytes=2 * 1024**3
            ):
                pass
            return True
        except FileNotFoundError:
            return False

    def reject_cache(self, key: str) -> None:
        self.remaining(30)
        if self.artifacts is None:
            raise ValueError("IMMUTABLE_BOUNDARY_REQUIRED")
        self.artifacts.reject_cache(key)

    def put_file(self, key: str, path: str, content_type: str) -> None:
        scoped(self.session, key)
        if "/renders/" in key and not key.endswith("/full.mp4"):
            if self.artifacts is None:
                raise ValueError("IMMUTABLE_BOUNDARY_REQUIRED")
            self.artifacts.put_path(key, Path(path), deadline=time.monotonic() + self.remaining(30))
            return
        url = self._sign(key, "put", content_type)
        self._transfer(url, "PUT", Path(path), 30, 2 * 1024**3, content_type)

    def put_bytes(self, key: str, data: bytes, content_type: str) -> None:
        with tempfile.TemporaryDirectory(dir=self.scratch) as temp:
            path = Path(temp) / "upload"
            path.write_bytes(data)
            self.put_file(key, str(path), content_type)
