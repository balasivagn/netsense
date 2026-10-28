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
    spec = _spec(tmp_path, "sleep_forever.py", str(pid_file), timeout_s=0.4)
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


def test_static_driver_protocol_assignment() -> None:
    from netsense_orch.drivers import SandboxDriver

    driver: SandboxDriver[LocalSandboxSpec] = LocalDriver()
    assert driver is not None


def test_concurrent_wait_and_terminate(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    pid_file = tmp_path / "pid"
    with LocalDriver().acquire(
        _spec(tmp_path, "sleep_forever.py", str(pid_file), timeout_s=30)
    ) as handle:
        pid = _read_pid(pid_file)
        entered = threading.Event()
        results: list[int] = []

        real_sleep = time.sleep

        def observed_sleep(duration: float) -> None:
            if threading.current_thread() is waiter:
                entered.set()
            real_sleep(duration)

        def wait() -> None:
            results.append(handle.wait())

        waiter = threading.Thread(target=wait)
        monkeypatch.setattr(time, "sleep", observed_sleep)
        waiter.start()
        assert entered.wait(1)
        start = time.monotonic()
        handle.terminate()
        waiter.join(1)
        assert not waiter.is_alive()
        assert time.monotonic() - start < 2
        assert results and results[0] < 0
    _assert_stopped(pid)


def test_short_wait_then_success(tmp_path: Path) -> None:
    with LocalDriver().acquire(_spec(tmp_path, "short_success.py")) as handle:
        with pytest.raises(LocalSandboxWaitTimeout):
            handle.wait(0.01)
        assert handle.wait() == 0


@pytest.mark.parametrize("timeout_s", [0, -1, float("inf"), float("nan"), True])
def test_caller_timeout_validation(tmp_path: Path, timeout_s: float) -> None:
    with LocalDriver().acquire(_spec(tmp_path, "short_success.py")) as handle:
        with pytest.raises((ValueError, TypeError)):
            handle.wait(timeout_s)


def test_post_spawn_initialization_failure_is_cleaned(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from netsense_orch.drivers import local_driver as module

    original = module._LocalSandboxHandle.start
    pid_file = tmp_path / "pid"
    spec = _spec(tmp_path, "sleep_forever.py", str(pid_file), name="init-failure")
    pids: list[int] = []

    def fail_after_start(handle: module._LocalSandboxHandle) -> None:
        original(handle)
        pids.append(_read_pid(pid_file))
        raise RuntimeError("initialization failed")

    with monkeypatch.context() as patch:
        patch.setattr(module._LocalSandboxHandle, "start", fail_after_start)
        with pytest.raises(RuntimeError, match="initialization failed"):
            with LocalDriver().acquire(spec):
                pytest.fail("must not yield")
    _assert_stopped(pids[0])
    with LocalDriver().acquire(_spec(tmp_path, "exit_success.py", name=spec.name)) as handle:
        assert handle.wait() == 0


def test_constructor_failure_starts_no_process(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from netsense_orch.drivers import local_driver as module

    spec = _spec(tmp_path, "exit_success.py", name="constructor-failure")

    def fail_uuid() -> str:
        raise RuntimeError("handle construction failed")

    with monkeypatch.context() as patch:
        patch.setattr(module, "uuid4", fail_uuid)
        with pytest.raises(RuntimeError, match="handle construction failed"):
            with LocalDriver().acquire(spec):
                pytest.fail("must not yield")
    with LocalDriver().acquire(spec) as handle:
        assert handle.wait() == 0


def test_reap_failure_retains_name_and_retry_sends_no_late_signal(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import subprocess

    from netsense_orch.drivers import LocalSandboxCleanupError
    from netsense_orch.drivers import local_driver as module

    pid_file = tmp_path / "pid"
    spec = _spec(tmp_path, "sleep_forever.py", str(pid_file), name="reap-failure")
    signals: list[int] = []
    original_killpg = os.killpg

    def record_signal(pgid: int, sig: int) -> None:
        signals.append(sig)
        original_killpg(pgid, sig)

    with monkeypatch.context() as patch:
        patch.setattr(os, "killpg", record_signal)
        with pytest.raises(LocalSandboxCleanupError):
            with LocalDriver().acquire(spec) as opaque:
                assert isinstance(opaque, module._LocalSandboxHandle)
                handle = opaque
                pid = _read_pid(pid_file)
                process = handle._process
                assert process is not None

                def fail_wait(timeout: float | None = None) -> int:
                    raise subprocess.TimeoutExpired("supervisor", timeout or 1)

                patch.setattr(process, "wait", fail_wait)
        assert not handle._closed
        assert LocalDriver._cleanup_pending[spec.name] is handle
        with pytest.raises(LocalSandboxNameInUseError):
            with LocalDriver().acquire(spec):
                pytest.fail("name must remain reserved")
    _assert_stopped(pid)
    with monkeypatch.context() as patch:
        patch.setattr(os, "killpg", record_signal)
        handle.terminate()
        handle.terminate()
        assert handle._closed
        assert signals == []  # Only the independent guardian may signal owned groups.
    # Explicit recovery of the retained reservation after confirmed retry.
    assert spec.name not in LocalDriver._cleanup_pending
    with LocalDriver().acquire(_spec(tmp_path, "exit_success.py", name=spec.name)) as new:
        assert new.wait() == 0


def test_no_signals_after_ownership_ends(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:

    with LocalDriver().acquire(_spec(tmp_path, "exit_success.py")) as handle:
        assert handle.wait() == 0
        handle.terminate()

        def forbidden_signal(pgid: int, sig: int) -> None:
            pytest.fail("signal after final reap")

        monkeypatch.setattr(os, "killpg", forbidden_signal)
        assert handle.poll() == 0
        assert handle.wait() == 0
        handle.terminate()


def test_exact_allowlist_and_environment_snapshot(tmp_path: Path) -> None:
    result = tmp_path / "env-result"
    env = {"NETSENSE_ALLOWED": "synthetic", "LC_CTYPE": "C.UTF-8"}
    spec = LocalSandboxSpec(
        name=f"env-{uuid4()}",
        command=(sys.executable, str(_FIXTURES / "check_env_exact.py"), str(result)),
        cwd=tmp_path,
        env=env,
        timeout_s=2,
    )
    env["NETSENSE_EXTRA"] = "synthetic"
    with LocalDriver().acquire(spec) as handle:
        assert handle.wait() == 0
    assert result.read_text() == "exact"


def test_failure_immediately_after_popen_cleans_supervisor(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from netsense_orch.drivers import local_driver as module

    name = "post-popen-failure"
    original = module._LocalSandboxHandle.start
    handles: list[module._LocalSandboxHandle] = []

    def capture_start(handle: module._LocalSandboxHandle) -> None:
        handles.append(handle)
        original(handle)

    def fail_setup(*args: object, **kwargs: object) -> str:
        raise RuntimeError("post-spawn setup failed")

    import json

    with monkeypatch.context() as patch:
        patch.setattr(module._LocalSandboxHandle, "start", capture_start)
        patch.setattr(json, "dumps", fail_setup)
        with pytest.raises(RuntimeError, match="post-spawn setup failed"):
            with LocalDriver().acquire(_spec(tmp_path, "exit_success.py", name=name)):
                pytest.fail("must not yield")
    process = handles[0]._process
    assert process is not None
    assert process.returncode is not None
    _assert_stopped(process.pid)
    with LocalDriver().acquire(_spec(tmp_path, "exit_success.py", name=name)) as handle:
        assert handle.wait() == 0


def test_receipt_precedes_release_and_parent_never_signals(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from netsense_orch.drivers import local_driver as module

    pid_file = tmp_path / "descendant"
    with LocalDriver().acquire(
        _spec(tmp_path, "parent_spawns_descendant.py", str(pid_file))
    ) as handle:
        assert isinstance(handle, module._LocalSandboxHandle)
        assert handle.wait() == 0
        assert not handle.receipt.exists()

        def forbidden(*args: object) -> None:
            pytest.fail("owner must not signal numeric identities")

        monkeypatch.setattr(os, "killpg", forbidden)
        handle.terminate()
        assert handle.receipt.exists()
    _assert_stopped(_read_pid(pid_file))


def test_hard_lifetime_without_owner_polling(tmp_path: Path) -> None:
    from netsense_orch.drivers import local_driver as module

    pid_file = tmp_path / "pid"
    with LocalDriver().acquire(
        _spec(tmp_path, "sleep_forever.py", str(pid_file), timeout_s=0.3)
    ) as handle:
        assert isinstance(handle, module._LocalSandboxHandle)
        pid = _read_pid(pid_file)
        _assert_stopped(pid)  # No poll/wait until independently killed.
        with pytest.raises(LocalSandboxTimeoutError):
            handle.wait()
        assert handle.receipt.exists()


def test_missing_receipt_retains_cleanup_for_retry(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from netsense_orch.drivers import LocalSandboxCleanupError
    from netsense_orch.drivers import local_driver as module

    spec = _spec(tmp_path, "exit_success.py", name="receipt-retry")
    with LocalDriver().acquire(spec) as opaque:
        assert isinstance(opaque, module._LocalSandboxHandle)
        handle = opaque
        assert handle.wait() == 0
        original = Path.exists
        with monkeypatch.context() as patch:
            patch.setattr(Path, "exists", lambda p: False if p == handle.receipt else original(p))
            with pytest.raises(LocalSandboxCleanupError):
                handle.terminate()
            assert not handle._closed
        handle.terminate()
        assert handle._closed


def test_owner_death_and_cross_process_name_lock(tmp_path: Path) -> None:
    import subprocess

    owner = subprocess.Popen(
        [sys.executable, str(_FIXTURES / "own_sandbox.py"), str(tmp_path)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        pid = _read_pid(tmp_path / "pid", timeout_s=3)
        spec = LocalSandboxSpec(
            name="cross-process-owner",
            command=(sys.executable, "-c", "pass"),
            cwd=tmp_path,
            env={},
            timeout_s=2,
            state_dir=tmp_path / "state",
        )
        with pytest.raises(LocalSandboxNameInUseError):
            with LocalDriver().acquire(spec):
                pytest.fail("cross-process duplicate must fail")
        owner.kill()
        owner.wait(timeout=2)
        _assert_stopped(pid, timeout_s=3)
        handle_id = (tmp_path / "handle").read_text()
        receipt = tmp_path / "state" / f"{handle_id}.released.json"
        deadline = time.monotonic() + 3
        while not receipt.exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        assert receipt.exists()
        # A fresh owner can acquire only after guardian's confirmed cleanup.
        with LocalDriver().acquire(spec) as handle:
            assert handle.wait() == 0
    finally:
        if owner.poll() is None:
            owner.kill()
        owner.wait(timeout=2)
