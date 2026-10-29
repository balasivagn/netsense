# L5 local subprocess driver — T1.11 PARTIAL local-driver slice

PR #9 remains draft. This is the local transport only, before runner integration;
it does **not** complete T1.11 or its full lifecycle acceptance criteria.

## API and ownership

- `LocalDriver.acquire(spec: LocalSandboxSpec) -> AbstractContextManager[SandboxHandle]`.
  The generic, contravariant `SandboxDriver[SpecT]` now permits the actual checked
  assignment `driver: SandboxDriver[LocalSandboxSpec] = LocalDriver()` without casts.
- `LocalSandboxSpec(name, command: tuple[str, ...], cwd: Path, env, timeout_s)` is
  frozen, snapshots the environment and validates a positive finite lifetime.
  The supplied environment is the complete command allowlist; there is no parent
  environment merge. The supervisor receives an empty environment and passes the
  snapshot explicitly to command Popen. Python/macOS runtime startup can add
  `LC_CTYPE` / `__CF_USER_TEXT_ENCODING`; the latter is accounted for in the real
  environment test. Credentials/config travel only on a private socket, never argv.
- The opaque handle retains `sandbox_id`, `name`, `created_at`, `poll()`,
  `wait(timeout_s=None)` and `terminate()`. No runner/shared JSON interface changed.
  `poll` and `wait` report the **command's** exit status, not the supervisor's.
  If forced cleanup precedes receipt of command status, the fallback is `-SIGKILL`.
- A private Python supervisor starts a new POSIX session, launches the command in
  its own group, reports ready/errno/exit via a non-inherited socket, and stays
  alive after command exit. Its TERM handler is a caught no-op (reset on command
  exec), not inherited SIG_IGN. The driver NEVER polls/waits/reaps this leader
  until its final group signal. Even an unexpected leader exit leaves the direct
  child PID pinned until reap. No waitid, ctypes layouts or process-table guesses.
- Cleanup serializes TERM, 0.2 s grace, final KILL, then a bounded 1 s leader reap.
  Before startup READY, cleanup skips TERM because its handler may not yet exist.
  After final KILL succeeds, retries only reap: there can be no later group signal.
  Successful repeated termination is a no-op. Descendants must remain in the group;
  this local transport is not OS isolation for commands that deliberately escape it.
- Waiters never hold the control lock across their sleep. A concurrent terminate
  can stop a long wait promptly. A short positive finite caller limit raises
  `LocalSandboxWaitTimeout` without killing or extending the immutable deadline.
  Deadline expiry during startup or a pending-command wait cleans up and raises
  `LocalSandboxTimeoutError`.
  **There is no independent hard-lifetime watchdog**: poll/idle ownership alone
  does not enforce the cap. The future lifecycle must call wait/terminate.
- Handle state is allocated before spawn. All post-spawn setup and context exits
  (including exceptions and cancellation) have the same finally cleanup path.
- Failed signaling/reaping raises `LocalSandboxCleanupError`; closure is never
  claimed and the name remains reserved. `_cleanup_pending` retains the handle /
  Popen so destructor reaping cannot destroy ownership. Retrying a retained handle's
  `terminate()` releases a failed-context reservation only after confirmed cleanup.
  A setup failure before yield has no public handle: its retained internal entry
  requires explicit lifecycle recovery, which is pending. No automatic retry or
  cross-process recovery is claimed. Names are excluded only within this process.

## Repair acceptance evidence

Real synthetic subprocess coverage includes success/nonzero status, caller
exception/cancellation, hard timeout, short wait then timeout or completion,
repeated terminate, concurrent wait/terminate, duplicate-name race/release,
spawn/constructor/immediate-post-spawn/post-start initialization failures,
unconfirmed reap with retained name and signal-free retry, failed final signal
with unreaped leader, command exit before TERM-ignoring descendants, explicit
signal-before-reap ordering, no signals after ownership ends, and environment
snapshot/allowlist/noninheritance. Static checking includes actual protocol use.

Validation on macOS / Python 3.12.12:

- `uv run --project services/orchestrator ruff check services/orchestrator` —
  `All checks passed!`
- `uv run --project services/orchestrator mypy --strict services/orchestrator` —
  `Success: no issues found in 7 source files`.
- `uv run --project services/orchestrator pytest services/orchestrator/tests/test_local_driver.py -q --basetemp=.orca-scratch/pytest-final`
  — `32 passed in 9.79s`.
- `PYTEST_ADDOPTS=--basetemp=.orca-scratch/pytest-check pnpm check` —
  98 JS tests, 95 runner tests, 33 orchestrator tests passed; 34 contracts verified;
  schema structural limits and offline Convex bindings verified.
- `scripts/secret-scan.sh` — history and working tree: `no leaks found`.
- `uv tool run --from pre-commit==4.7.0 pre-commit run --all-files` —
  `gitleaks staged secrets ... Passed`; normal commit also runs the real hook.
- E2E is not yet defined on this branch (T1.31 pending); no paid/live calls made.

## Still UNTESTED / pending

Runner integration, full orchestration claim/watch/finalize paths, automatic
independent hard lifetime, heartbeat/stale watching, cross-process name exclusion,
PID/sandbox persistence, crash/restart/orphan sweeper, Modal and paid APIs remain
**UNTESTED/pending**. The broader T1.11 success/failure/timeout/stale-heartbeat and
crash-recovery acceptance suite is not satisfied by this transport slice.
