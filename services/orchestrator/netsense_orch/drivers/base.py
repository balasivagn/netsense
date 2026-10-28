"""Small, transport-independent sandbox driver interfaces.

The orchestration lifecycle owns heartbeat watching and stale-job decisions. Drivers
only start and reliably release an already-authorized command.
"""

from __future__ import annotations

from contextlib import AbstractContextManager
from datetime import datetime
from typing import Protocol


class LocalSandboxWaitTimeout(TimeoutError):
    """A caller's short bounded wait elapsed; the sandbox is still owned."""


class LocalSandboxTimeoutError(TimeoutError):
    """The sandbox's immutable wall-clock lifetime elapsed and it was terminated."""


class SandboxHandle(Protocol):
    """A running sandbox with no command, environment, or output exposure."""

    @property
    def sandbox_id(self) -> str: ...

    @property
    def name(self) -> str: ...

    @property
    def created_at(self) -> datetime: ...

    def poll(self) -> int | None: ...

    def wait(self, timeout_s: float | None = None) -> int: ...

    def terminate(self) -> None: ...


class SandboxDriver(Protocol):
    """Only context-managed acquisition is public so every sandbox is released."""

    def acquire(self, spec: object) -> AbstractContextManager[SandboxHandle]: ...
