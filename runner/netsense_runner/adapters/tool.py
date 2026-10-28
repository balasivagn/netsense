"""Subprocess adapter with timeout process-group cleanup and scrubbed failures."""

from __future__ import annotations

import math
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
    """Arbitrary tool output can contain plain credentials or transcript text."""
    return "TOOL_STDERR_REDACTED" if stderr else ""


class ToolAdapter:
    def run(self, command: tuple[str, ...], *, timeout_s: float) -> ToolResult:
        if not math.isfinite(timeout_s) or timeout_s <= 0:
            raise ValueError("INVALID_TOOL_TIMEOUT")
        try:
            process = subprocess.Popen(
                command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True
            )
        except OSError:
            raise ToolExecutionError("INFRA_EXEC") from None
        try:
            stdout, stderr = process.communicate(timeout=timeout_s)
        except subprocess.TimeoutExpired:
            raise ToolExecutionError("STAGE_TIMEOUT") from None
        finally:
            # Also clean up on cancellation or a communicate failure. A successful
            # parent may have left descendants in its process group.
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
            if process.stdout is not None:
                process.stdout.close()
            if process.stderr is not None:
                process.stderr.close()
        if process.returncode != 0:
            error = ToolExecutionError("INFRA_EXEC")
            error.add_note(_scrub(stderr))
            raise error
        return ToolResult(stdout=stdout, stderr=_scrub(stderr))
