"""Subprocess adapter with timeout process-group cleanup and scrubbed failures."""

from __future__ import annotations

import os
import signal
import subprocess
from dataclasses import dataclass


class ToolExecutionError(RuntimeError):
    def __init__(self, error_code: str) -> None:
        super().__init__(error_code)
        self.error_code = error_code


@dataclass(frozen=True, slots=True)
class ToolResult:
    stdout: bytes
    stderr: str


def _scrub(stderr: bytes) -> str:
    """Keep bounded diagnostics but never URLs/query strings that can contain signed credentials."""
    decoded = stderr.decode("utf-8", errors="replace")
    return " ".join(part for part in decoded.split() if "://" not in part and "=" not in part)[:500]


class ToolAdapter:
    def run(self, command: tuple[str, ...], *, timeout_s: float) -> ToolResult:
        try:
            process = subprocess.Popen(
                command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True
            )
        except OSError:
            raise ToolExecutionError("INFRA_EXEC") from None
        try:
            stdout, stderr = process.communicate(timeout=timeout_s)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.communicate()
            raise ToolExecutionError("STAGE_TIMEOUT") from None
        if process.returncode != 0:
            error = ToolExecutionError("INFRA_EXEC")
            error.add_note(_scrub(stderr))
            raise error
        return ToolResult(stdout=stdout, stderr=_scrub(stderr))
