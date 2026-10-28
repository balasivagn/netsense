"""Test-only actual Lifecycle + HTTP service + owned sleeping process probe."""
from __future__ import annotations

import json
import os
import sys
from contextlib import contextmanager
from dataclasses import replace
from pathlib import Path

from netsense_orch.drivers import LocalDriver
from netsense_orch.lifecycle import Lifecycle
from netsense_orch.service import Service


class SleepingDriver(LocalDriver):
    @contextmanager
    def acquire(self, spec):
        command = (sys.executable, str(Path(__file__).with_name("sleep_forever.py")), str(spec.cwd / "pid"))
        with super().acquire(replace(spec, command=command, timeout_s=10)) as handle:
            yield handle


service = Service(os.environ["CONVEX_SITE_URL"], os.environ["CONVEX_SERVICE_SECRET"])
root = Path(os.environ["NETSENSE_LOCAL_STATE_DIR"])
runtime = Lifecycle(service, root, sys.executable, root.parent)
runtime.watch_s = 0.1
runtime.driver = SleepingDriver()
claim = service.claim(runtime.owner)
assert claim is not None
runtime.run(claim)
receipts = list(root.glob("*.released.json"))
assert len(receipts) == 1
assert json.loads(receipts[0].read_text())["exitCode"] is not None
print("OWNED_CONTROL_COMPLETE")
