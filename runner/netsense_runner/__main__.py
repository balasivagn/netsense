"""Host-injected entry point; no implicit provider, credential, or storage fallback."""

from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

from netsense_runner.dag import Runner


def main(runner: Runner | None = None) -> int:
    """A configured host calls main(runner). Unconfigured module execution fails closed.

    The host owns storage signing, the atomic daily ledger, pinned worker
    factories, and cleanup of resources it has registered as owned by this run.
    """
    if runner is None:
        if os.environ.get("NETSENSE_LOCAL_FAKE") != "1":
            print("RUNNER_DEPENDENCIES_REQUIRED", file=sys.stderr)
            return 78
        parser = argparse.ArgumentParser()
        parser.add_argument("--job", required=True)
        args = parser.parse_args()
        try:
            from netsense_runner.host import build_runner

            gate = os.environ.get("NETSENSE_RUNNER_START_FILE")
            if gate:
                deadline = time.monotonic() + 10
                while not Path(gate).is_file():
                    if time.monotonic() >= deadline:
                        raise ValueError("REGISTRATION_REQUIRED")
                    time.sleep(0.01)
            runner = build_runner(args.job)
        except Exception:
            print("RUNNER_CONFIGURATION_REJECTED", file=sys.stderr)
            return 78
    outcome = runner.run()
    return 1 if outcome.status == "failed" else 0


if __name__ == "__main__":
    raise SystemExit(main())
