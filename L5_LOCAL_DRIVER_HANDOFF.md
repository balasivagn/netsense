# L5 local subprocess driver — T1.11 local-driver slice

This slice supplies `LocalDriver.acquire(LocalSandboxSpec)` only. It starts a
command in a new session with an exact caller-supplied environment and no output
pipes, then always terminates the process group and reaps the direct child when
the context exits. `LocalSandboxSpec` is frozen, copies `env`, and rejects
non-finite or non-positive lifetimes.

`handle.wait()` uses the monotonic deadline set when the process is created.
`LocalSandboxWaitTimeout` is a bounded caller wait and leaves the context owner
in control. `LocalSandboxTimeoutError` is the hard spec lifetime: the driver has
killed/reaped the group. `terminate()` is idempotent and sends TERM followed by
a short bounded grace and KILL to the original process group, covering a parent
that has already exited while descendants remain.

The in-memory reservation map prevents duplicate names only within one running
orchestrator process. Cross-process name protection, PID persistence, restart
recovery, heartbeat/stale watching, `sandboxes` persistence, job finalization,
and the production sweeper are deliberately not implemented here. Those pieces,
along with the Modal driver, remain **UNTESTED/pending** for the broader T1.11
lifecycle work. This module does not choose runtime environment variable names
or provide credentials; the future lifecycle passes only its allowed values.
