"""Local subprocess sandbox driver with process-group cleanup.

Local development only. An independent guardian owns command-group signalling.
Durable receipts and cross-process name locks support safe restart reconciliation;
no persisted PID is ever used for signalling.
"""

from __future__ import annotations

import fcntl
import hashlib
import json
import math
import os
import signal
import socket
import subprocess
import sys
import threading
import time
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from types import MappingProxyType
from typing import Final
from uuid import uuid4

from .base import LocalSandboxTimeoutError, LocalSandboxWaitTimeout, SandboxHandle

_TERMINATE_GRACE_S: Final = 0.2
_REAP_WAIT_S: Final = 1.0


class LocalSandboxNameInUseError(RuntimeError):
    """A local orchestrator process already owns this sandbox name."""


def _positive_finite(value: float, field_name: str) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise TypeError(f"{field_name} must be a positive finite number")
    result = float(value)
    if not math.isfinite(result) or result <= 0:
        raise ValueError(f"{field_name} must be a positive finite number")
    return result


@dataclass(frozen=True, slots=True)
class LocalSandboxSpec:
    """Immutable inputs for one local sandbox subprocess.

    ``env`` is copied and passed exactly to :class:`subprocess.Popen`; it is not
    merged with the parent environment. The lifecycle must supply any safe PATH
    or runtime configuration required by its command.
    """

    name: str
    command: tuple[str, ...]
    cwd: Path
    env: Mapping[str, str] = field(default_factory=dict)
    timeout_s: float = 1.0
    state_dir: Path | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.name, str) or not self.name.strip():
            raise ValueError("name must be a non-empty string")
        if not isinstance(self.command, tuple):
            raise TypeError("command must be a tuple of non-empty strings")
        command = tuple(self.command)
        if not command or any(not isinstance(part, str) or not part for part in command):
            raise ValueError("command must be a non-empty tuple of non-empty strings")
        if not isinstance(self.cwd, Path):
            raise TypeError("cwd must be a pathlib.Path")
        env = dict(self.env)
        if any(
            not isinstance(key, str) or not isinstance(value, str) for key, value in env.items()
        ):
            raise TypeError("env must map strings to strings")
        object.__setattr__(self, "command", command)
        object.__setattr__(self, "env", MappingProxyType(env))
        object.__setattr__(self, "timeout_s", _positive_finite(self.timeout_s, "timeout_s"))


class LocalSandboxCleanupError(RuntimeError):
    """Cleanup is unconfirmed; handle and name remain reserved for retry."""


class _LocalSandboxHandle:
    """Owns an unreaped supervisor until the last group signal is sent."""

    def __init__(self, spec: LocalSandboxSpec) -> None:
        self._spec = spec
        self._sandbox_id = str(uuid4())
        self._created_at = datetime.now(UTC)
        self._deadline = time.monotonic() + spec.timeout_s
        self._lock = threading.RLock()
        self._closed = False
        self._signals_done = False
        self._process: subprocess.Popen[bytes] | None = None
        self._channel: socket.socket | None = None
        self._buffer = b""
        self._result: int | None = None
        self._ready = False
        self._startup_errno: int | None = None
        self._name_file: int | None = None
        root = spec.state_dir or spec.cwd / ".orca-scratch/local-sandboxes"
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.receipt = root / (self._sandbox_id + ".released.json")
        self._lock_path = root / (hashlib.sha256(spec.name.encode()).hexdigest() + ".lock")

    def start(self) -> None:
        self._name_file = os.open(self._lock_path, os.O_CREAT | os.O_RDWR, 0o600)
        try:
            fcntl.flock(self._name_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(self._name_file)
            self._name_file = None
            raise LocalSandboxNameInUseError("local sandbox name is already in use") from None
        channel, child_channel = socket.socketpair()
        self._channel = channel
        try:
            self._process = subprocess.Popen(
                (
                    sys.executable,
                    "-I",
                    str(Path(__file__).with_name("_local_supervisor.py")),
                    str(child_channel.fileno()),
                ),
                cwd=self._spec.cwd,
                env={},
                shell=False,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
                pass_fds=(child_channel.fileno(), self._name_file),
            )
        finally:
            child_channel.close()
        # All potentially failing post-spawn setup is inside acquire's finally.
        remaining = self._deadline - time.monotonic()
        if remaining <= 0:
            raise LocalSandboxTimeoutError("local sandbox startup lifetime elapsed")
        channel.settimeout(remaining)
        try:
            channel.sendall(
                json.dumps(
                    {
                        "command": self._spec.command,
                        "env": dict(self._spec.env),
                        "deadline": self._deadline,
                        "receipt": str(self.receipt.resolve()),
                        "id": self.sandbox_id,
                        "lockFd": self._name_file,
                    }
                ).encode()
                + b"\n"
            )
        except TimeoutError:
            raise LocalSandboxTimeoutError("local sandbox startup lifetime elapsed") from None
        channel.setblocking(False)
        while not self._ready:
            self.poll()
            if self._startup_errno is not None:
                raise OSError(self._startup_errno, "local command startup failed")
            if time.monotonic() >= self._deadline:
                raise LocalSandboxTimeoutError("local sandbox startup lifetime elapsed")
            time.sleep(0.005)

    @property
    def sandbox_id(self) -> str:
        return self._sandbox_id

    @property
    def name(self) -> str:
        return self._spec.name

    @property
    def created_at(self) -> datetime:
        return self._created_at

    def poll(self) -> int | None:
        with self._lock:
            if self._channel is not None and not self._closed:
                while True:
                    try:
                        chunk = self._channel.recv(4096)
                    except (BlockingIOError, ConnectionResetError):
                        break
                    if not chunk:
                        break
                    self._buffer += chunk
                while b"\n" in self._buffer:
                    line, self._buffer = self._buffer.split(b"\n", 1)
                    if line == b"ready":
                        self._ready = True
                    elif line.startswith(b"exit "):
                        self._result = int(line[5:])
                    elif line.startswith(b"error "):
                        self._startup_errno = int(line[6:])
            return self._result

    def wait(self, timeout_s: float | None = None) -> int:
        caller_limit = None if timeout_s is None else _positive_finite(timeout_s, "timeout_s")
        caller_deadline = None if caller_limit is None else time.monotonic() + caller_limit
        while True:
            result = self.poll()
            if self.receipt.exists():
                receipt = json.loads(self.receipt.read_text())
                if receipt["terminatedBy"] == "timeout":
                    self.terminate()
                    raise LocalSandboxTimeoutError("local sandbox lifetime elapsed")
            if result is not None:
                return result
            now = time.monotonic()
            if now >= self._deadline:
                self.terminate()
                raise LocalSandboxTimeoutError("local sandbox lifetime elapsed")
            if caller_deadline is not None and now >= caller_deadline:
                raise LocalSandboxWaitTimeout("local sandbox wait elapsed")
            # No control lock is held while waiting; terminate can interrupt promptly.
            remaining = self._deadline - now
            if caller_deadline is not None:
                remaining = min(remaining, caller_deadline - now)
            time.sleep(min(0.005, remaining))

    def terminate(self) -> None:
        with self._lock:
            if self._closed:
                return
            process = self._process
            if process is not None:
                if not self._signals_done:
                    try:
                        if self._channel is not None:
                            self._channel.settimeout(0.2)
                            try:
                                self._channel.sendall(b"stop\n")
                            except (BrokenPipeError, ConnectionResetError):
                                pass
                        self._signals_done = True
                    except OSError as exc:
                        raise LocalSandboxCleanupError("local sandbox stop unconfirmed") from exc
                try:
                    process.wait(timeout=4)
                except (subprocess.TimeoutExpired, OSError) as exc:
                    raise LocalSandboxCleanupError("local sandbox reap unconfirmed") from exc
                # No PID signalling here: only the guardian owns the command group.
                if self._ready and not self.receipt.exists():
                    raise LocalSandboxCleanupError("local sandbox receipt missing")
                if self._channel is not None:
                    self._channel.setblocking(False)
                self.poll()
                if self._result is None:
                    self._result = -signal.SIGKILL
            if self._channel is not None:
                self._channel.close()
            if self._name_file is not None:
                os.close(self._name_file)
                self._name_file = None
            self._closed = True
            with LocalDriver._names_lock:
                if LocalDriver._cleanup_pending.get(self.name) is self:
                    LocalDriver._cleanup_pending.pop(self.name)
                    LocalDriver._reserved_names.discard(self.name)


class LocalDriver:
    """Context-managed local subprocesses with cross-process name locks.

    All owners must use the same private state_dir on one local filesystem.
    Cleanup failures retain their handle/name for a later retry.
    """

    _cleanup_pending: Final[dict[str, _LocalSandboxHandle]] = {}
    _names_lock: Final = threading.Lock()
    _reserved_names: Final[set[str]] = set()

    @contextmanager
    def acquire(self, spec: LocalSandboxSpec) -> Iterator[SandboxHandle]:
        self._reserve(spec.name)
        handle: _LocalSandboxHandle | None = None
        try:
            handle = _LocalSandboxHandle(spec)
            handle.start()
            yield handle
        finally:
            if handle is not None:
                try:
                    handle.terminate()
                except BaseException:
                    # Keep the Popen alive too: its destructor must not implicitly
                    # reap the leader while a retry could still need to signal it.
                    with handle._lock, self._names_lock:
                        if handle._closed:
                            self._reserved_names.discard(spec.name)
                        else:
                            self._cleanup_pending[spec.name] = handle
                    raise
            self._release(spec.name)

    @classmethod
    def _reserve(cls, name: str) -> None:
        with cls._names_lock:
            if name in cls._reserved_names:
                raise LocalSandboxNameInUseError("local sandbox name is already in use")
            cls._reserved_names.add(name)

    @classmethod
    def _release(cls, name: str) -> None:
        with cls._names_lock:
            cls._cleanup_pending.pop(name, None)
            cls._reserved_names.discard(name)
