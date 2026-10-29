"""Local fake orchestration only; no production or Modal provider substitution."""

from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

from netsense_orch.lifecycle import Lifecycle
from netsense_orch.service import Service


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    try:
        if (
            os.environ.get("NETSENSE_ENV") not in {"test", "development"}
            or os.environ.get("NETSENSE_LOCAL_FAKE") != "1"
            or os.environ.get("SANDBOX_DRIVER") != "local"
        ):
            raise ValueError
        lifecycle = Lifecycle(
            Service(os.environ["CONVEX_SITE_URL"], os.environ["CONVEX_SERVICE_SECRET"]),
            Path(os.environ["NETSENSE_LOCAL_STATE_DIR"]),
            sys.executable,
            Path.cwd(),
        )
        while True:
            if time.monotonic() >= lifecycle.next_sweep:
                lifecycle.sweep()  # startup/periodic, including inside long-running jobs.
                lifecycle.next_sweep = time.monotonic() + lifecycle.sweep_s
            claim = lifecycle.service.claim(lifecycle.owner)
            if claim:
                lifecycle.run(claim)
            if args.once:
                return 0
            time.sleep(lifecycle.poll_s)
    except KeyboardInterrupt:
        return 130
    except Exception:
        print("LOCAL_RUNTIME_FAILED", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
