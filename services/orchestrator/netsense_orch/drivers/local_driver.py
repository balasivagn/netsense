"""Local subprocess sandbox driver with process-group cleanup.

This is deliberately a narrow local-development and test transport. It does not
persist PIDs, scan process tables, watch heartbeats, or recover after an
orchestrator crash. Those production lifecycle/sweeper responsibilities remain
UNTESTED and pending the T1.11 integration work.
"""

from __future__ import annotations

import math
import os
import signal
import subprocess
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


class _LocalSandboxHandle:
    """One process-group sandbox, released by :meth:`LocalDriver.acquire`."""

    def __init__(self, spec: LocalSandboxSpec, process: subprocess.Popen[bytes]) -> None:
        self._spec = spec
        self._process = process
        self._pgid = process.pid
        self._sandbox_id = str(uuid4())
        self._created_at = datetime.now(UTC)
        self._deadline = time.monotonic() + spec.timeout_s
        self._lock = threading.RLock()
        self._closed = False

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
            return self._process.poll()

    def wait(self, timeout_s: float | None = None) -> int:
        """Wait without allowing a caller timeout to extend the hard lifetime.

        A shorter ``timeout_s`` raises :class:`LocalSandboxWaitTimeout` while the
        context still owns the sandbox. Reaching the spec lifetime kills/reaps the
        whole group and raises :class:`LocalSandboxTimeoutError`.
        """
        caller_limit = None if timeout_s is None else _positive_finite(timeout_s, "timeout_s")
        with self._lock:
            result = self._process.poll()
            if result is not None:
                return result
            remaining = self._deadline - time.monotonic()
            if remaining <= 0:
                self.terminate()
                raise LocalSandboxTimeoutError("local sandbox lifetime elapsed")
            wait_for = remaining if caller_limit is None else min(caller_limit, remaining)
            try:
                return self._process.wait(timeout=wait_for)
            except subprocess.TimeoutExpired as exc:
                if time.monotonic() >= self._deadline:
                    self.terminate()
                    raise LocalSandboxTimeoutError("local sandbox lifetime elapsed") from None
                raise LocalSandboxWaitTimeout("local sandbox wait elapsed") from exc

    def terminate(self) -> None:
        """Idempotently terminate this process group and reap its direct parent."""
        with self._lock:
            if self._closed:
                return
            self._signal_group(signal.SIGTERM)
            self._wait_parent(_TERMINATE_GRACE_S)
            # The parent may have exited while descendants retained the group.
            # SIGKILL is still sent to that original group before ownership ends.
            self._signal_group(signal.SIGKILL)
            self._wait_parent(_REAP_WAIT_S)
            self._closed = True

    def _signal_group(self, sig: signal.Signals) -> None:
        try:
            os.killpg(self._pgid, sig)
        except ProcessLookupError:
            # The group is already gone; no PID/PGID is used after ``_closed``.
            return

    def _wait_parent(self, timeout_s: float) -> None:
        try:
            self._process.wait(timeout=timeout_s)
        except subprocess.TimeoutExpired:
            return


class LocalDriver:
    """Context-managed local subprocesses with process-local name exclusion.

    Name protection is intentionally in-memory and only covers concurrent calls
    in this orchestrator process. Cross-process protection and restart/orphan
    recovery require the production lifecycle plus sweeper and are still pending.
    """

    _names_lock: Final = threading.Lock()
    _reserved_names: Final[set[str]] = set()

    @contextmanager
    def acquire(self, spec: LocalSandboxSpec) -> Iterator[SandboxHandle]:
        self._reserve(spec.name)
        handle: _LocalSandboxHandle | None = None
        try:
            process = subprocess.Popen(
                spec.command,
                cwd=spec.cwd,
                env=dict(spec.env),
                shell=False,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
            handle = _LocalSandboxHandle(spec, process)
            yield handle
        finally:
            if handle is not None:
                handle.terminate()
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
            cls._reserved_names.discard(name)
