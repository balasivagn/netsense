"""Synthetic owner killed by tests to exercise guardian EOF cleanup."""
from __future__ import annotations

import sys
import time
from pathlib import Path

from netsense_orch.drivers import LocalDriver, LocalSandboxSpec

root = Path(sys.argv[1])
spec = LocalSandboxSpec(
    name='cross-process-owner',
    command=(sys.executable, str(Path(__file__).with_name('sleep_forever.py')), str(root/'pid')),
    cwd=root, env={}, timeout_s=10, state_dir=root/'state',
)
with LocalDriver().acquire(spec) as handle:
    (root/'handle').write_text(handle.sandbox_id)
    while True:
        time.sleep(1)
