from __future__ import annotations

import asyncio
import os
import sys
import threading
import time
from pathlib import Path
from uuid import uuid4

import pytest

from netsense_orch.drivers import (
    LocalDriver,
    LocalSandboxSpec,
    LocalSandboxTimeoutError,
    LocalSandboxWaitTimeout,
)
from netsense_orch.drivers.local_driver import LocalSandboxNameInUseError

_FIXTURES = Path(__file__).parents[3] / "fixtures" / "synthetic" / "local_driver"


def _spec(
    tmp_path: Path,
    script: str,
    *args: str,
    name: str | None = None,
    timeout_s: float = 2,
) -> LocalSandboxSpec:
    return LocalSandboxSpec(
        name=name or f"local-driver-{uuid4()}",
        command=(sys.executable, "-u", str(_FIXTURES / script), *args),
        cwd=tmp_path,
        env={},
        timeout_s=timeout_s,
    )


def _read_pid(path: Path, timeout_s: float = 1) -> int:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if path.exists():
            return int(path.read_text(encoding="utf-8"))
        time.sleep(0.01)
    raise AssertionError("synthetic child did not publish its PID")


def _is_live(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    if sys.platform.startswith("linux"):
        stat_path = Path(f"/proc/{pid}/stat")
        if stat_path.exists() and ") Z " in stat_path.read_text(encoding="utf-8"):
            return False
    return True


def _assert_stopped(pid: int, timeout_s: float = 2) -> None:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if not _is_live(pid):
            return
        time.sleep(0.02)
    raise AssertionError(f"process {pid} is still live")


def test_success_releases_name_and_reaps_process(tmp_path: Path) -> None:
    spec = _spec(tmp_path, "exit_success.py", name="success-release")
    driver = LocalDriver()
    with driver.acquire(spec) as handle:
        assert handle.wait() == 0
        assert handle.poll() == 0
    with driver.acquire(spec) as handle:
        assert handle.wait() == 0


def test_nonzero_exit_is_returned(tmp_path: Path) -> None:
    with LocalDriver().acquire(_spec(tmp_path, "exit_nonzero.py")) as handle:
        assert handle.wait() == 7


def test_caller_exception_after_acquire_terminates_process_group(tmp_path: Path) -> None:
    pid_file = tmp_path / "pid"
    spec = _spec(tmp_path, "sleep_forever.py", str(pid_file))
    with pytest.raises(ValueError, match="registration failed"):
        with LocalDriver().acquire(spec):
            pid = _read_pid(pid_file)
            raise ValueError("registration failed")
    _assert_stopped(pid)


def test_cancellation_early_exit_terminates_process_group(tmp_path: Path) -> None:
    pid_file = tmp_path / "pid"
    spec = _spec(tmp_path, "sleep_forever.py", str(pid_file))
    with pytest.raises(asyncio.CancelledError):
        with LocalDriver().acquire(spec):
            pid = _read_pid(pid_file)
            raise asyncio.CancelledError()
    _assert_stopped(pid)


def test_hard_lifetime_timeout_kills_and_reaps(tmp_path: Path) -> None:
    pid_file = tmp_path / "pid"
    spec = _spec(tmp_path, "sleep_forever.py", str(pid_file), timeout_s=0.1)
    with LocalDriver().acquire(spec) as handle:
        pid = _read_pid(pid_file)
        with pytest.raises(LocalSandboxTimeoutError):
            handle.wait()
    _assert_stopped(pid)


def test_short_wait_does_not_restart_lifetime_or_kill(tmp_path: Path) -> None:
    pid_file = tmp_path / "pid"
    spec = _spec(tmp_path, "sleep_forever.py", str(pid_file), timeout_s=0.5)
    with LocalDriver().acquire(spec) as handle:
        pid = _read_pid(pid_file)
        with pytest.raises(LocalSandboxWaitTimeout):
            handle.wait(timeout_s=0.05)
        assert _is_live(pid)
        with pytest.raises(LocalSandboxTimeoutError):
            handle.wait()
    _assert_stopped(pid)


def test_repeated_terminate_is_idempotent(tmp_path: Path) -> None:
    pid_file = tmp_path / "pid"
    with LocalDriver().acquire(_spec(tmp_path, "sleep_forever.py", str(pid_file))) as handle:
        pid = _read_pid(pid_file)
        handle.terminate()
        handle.terminate()
        assert handle.poll() is not None
    _assert_stopped(pid)


def test_spawn_failure_releases_name(tmp_path: Path) -> None:
    name = "spawn-failure-release"
    bad_spec = LocalSandboxSpec(
        name=name,
        command=(str(tmp_path / "does-not-exist"),),
        cwd=tmp_path,
        env={},
        timeout_s=1,
    )
    driver = LocalDriver()
    with pytest.raises(FileNotFoundError):
        with driver.acquire(bad_spec):
            pass
    with driver.acquire(_spec(tmp_path, "exit_success.py", name=name)) as handle:
        assert handle.wait() == 0


def test_duplicate_name_race_starts_only_one_process(tmp_path: Path) -> None:
    pid_file = tmp_path / "pid"
    spec = _spec(tmp_path, "sleep_forever.py", str(pid_file), name="duplicate-race")
    barrier = threading.Barrier(2)
    entered = threading.Event()
    release = threading.Event()
    outcomes: list[str] = []

    def acquire_once() -> None:
        barrier.wait()
        try:
            with LocalDriver().acquire(spec):
                outcomes.append("acquired")
                entered.set()
                release.wait(timeout=1)
        except LocalSandboxNameInUseError:
            outcomes.append("duplicate")

    first = threading.Thread(target=acquire_once)
    second = threading.Thread(target=acquire_once)
    first.start()
    second.start()
    assert entered.wait(timeout=1)
    pid = _read_pid(pid_file)
    release.set()
    first.join(timeout=2)
    second.join(timeout=2)
    assert not first.is_alive()
    assert not second.is_alive()
    assert sorted(outcomes) == ["acquired", "duplicate"]
    _assert_stopped(pid)


def test_parent_exit_still_terminates_ignoring_descendant(tmp_path: Path) -> None:
    descendant_pid_file = tmp_path / "descendant-pid"
    spec = _spec(tmp_path, "parent_spawns_descendant.py", str(descendant_pid_file))
    with LocalDriver().acquire(spec) as handle:
        assert handle.wait() == 0
        descendant_pid = _read_pid(descendant_pid_file)
        assert _is_live(descendant_pid)
    _assert_stopped(descendant_pid)


def test_parent_environment_is_not_inherited(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    variable_name = f"NETSENSE_PARENT_ONLY_{uuid4().hex.upper()}"
    monkeypatch.setenv(variable_name, uuid4().hex)
    result_file = tmp_path / "result"
    spec = _spec(tmp_path, "check_env_absent.py", str(result_file), variable_name)
    with LocalDriver().acquire(spec) as handle:
        assert handle.wait() == 0
    assert result_file.read_text(encoding="utf-8") == "absent"


@pytest.mark.parametrize("timeout_s", [0, -1, float("inf"), float("nan")])
def test_spec_rejects_non_positive_or_non_finite_timeout(tmp_path: Path, timeout_s: float) -> None:
    with pytest.raises(ValueError):
        _spec(tmp_path, "exit_success.py", timeout_s=timeout_s)


def test_spec_rejects_non_tuple_command(tmp_path: Path) -> None:
    with pytest.raises(TypeError, match="tuple"):
        LocalSandboxSpec(
            name="invalid-command",
            command=[sys.executable],  # type: ignore[arg-type]
            cwd=tmp_path,
            env={},
            timeout_s=1,
        )
