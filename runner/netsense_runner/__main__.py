"""Host-injected entry point; no implicit provider, credential, or storage fallback."""

from __future__ import annotations

import sys

from netsense_runner.dag import Runner


def main(runner: Runner | None = None) -> int:
    """A configured host calls main(runner). Unconfigured module execution fails closed.

    The host owns storage signing, the atomic daily ledger, pinned worker
    factories, and cleanup of resources it has registered as owned by this run.
    """
    if runner is None:
        print("RUNNER_DEPENDENCIES_REQUIRED", file=sys.stderr)
        return 78
    outcome = runner.run()
    return 1 if outcome.status == "failed" else 0


if __name__ == "__main__":
    raise SystemExit(main())
