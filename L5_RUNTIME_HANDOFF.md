# L5 executable local runtime — T1.09 / T1.11 PARTIAL

Base is exact reviewed `c2cea96518bd237db98fa984771c83d7d71d8212`;
branch `lane/l5-local-runtime`. No subagents, other checkouts, paid calls, real-person
media, web UI, upload backend edits, service provisioning or deployment.

## Executable path and commands

From this repository root, after `pnpm install` and `uv sync --project
services/orchestrator`:

```sh
pnpm orchestrator --once
pnpm orchestrator
uv run --project services/orchestrator python -m netsense_orch --once
```

The first/third command claim at most one job. The second polls serially and runs
startup/periodic reconciliation between jobs. The actual child command is the
orchestrator's Python executable followed by `-m netsense_runner --job <jobId>`.
It runs in the same installed environment (orchestrator has an editable local
runner dependency). `--once` exits after lifecycle/release processing; job failure
is recorded in the service and is not itself the orchestrator process's exit code.
Unconfigured runner invocation retains exit 78. No implicit provider fallback.

Required parent environment names:

- `NETSENSE_ENV` (`test` or `development`), `NETSENSE_LOCAL_FAKE` (explicit `1`),
  `SANDBOX_DRIVER` (`local`). Production/default fake use fails closed.
- `CONVEX_SITE_URL`, `CONVEX_SERVICE_SECRET`, `VM_API_BASE_URL`: existing service
  and VM origins and externally configured service authentication. No credential
  values are supplied or invented here.
- `NETSENSE_LOCAL_STATE_DIR`: private shared durable directory for all local
  orchestrators on this host. Keep it across restarts. No persisted PID signalling.
- `NETSENSE_ARTIFACT_ROOT`: trusted local VM object root, the same directory as
  the web server's `LOCAL_STORAGE_DIR`. It must already exist.
- `NETSENSE_FAKE_FIXTURES`: explicit absolute path ending in
  `fixtures/synthetic/dag`; never a production runtime seed.
- `NETSENSE_RUNNER_SCRATCH`: private durable runner directory. Contains bounded
  media scratch and one-way job admission markers; keep across restarts.
- `PATH`: must locate real `ffmpeg` and `ffprobe`. Optional `TMPDIR` controls tool
  temporary files; keep disposable task data in this worktree or `$TMPDIR`.

The child receives only these safe settings, `PATH`/optional `TMPDIR`, its
claim-returned `NETSENSE_JOB_TOKEN`, and a private generated
`NETSENSE_RUNNER_START_FILE`. It receives no Clerk, storage signing, worker HMAC
master, service secret, vendor key, Modal key or parent environment merge. The
startup gate opens only after sandbox registration succeeds. The web server still
needs its existing worker verification/storage signing configuration; those
secrets stay on the server.

A prepared queued job must already have an upload and coach-tapped subject and
pin an explicit fake config. `fixtures/synthetic/dag/pipeline_config.local.json`
is a test-only example of the accepted registry: actual local
`transcode.ffmpeg@1`, `check.rules@1`, `render.ffmpeg@1`; synthetic model stages
use `<stage>.synthetic-test@1`, provider `fake`, model null. The running host
**never** reads this config file or overwrites pinned config. The integration test
prepares its database locally through convex-test; it provisions nothing live.

## Storage and wire changes

All worker persistence uses the existing typed HTTP client. Signing calls the
actual VM `POST /api/worker/sign` `{ops}` wire. Signed GET/PUT transports enforce
expiry, total subprocess deadlines, streaming byte caps, no redirects/proxies,
fixed scrubbed errors, and owned process/pipe cleanup. Renderer download,
track-loader and object-exists adapters honor their explicit bounds. Stage
storage operations also share the stage deadline through thread-local context.

Immutable JSON artifacts/receipts/tracks/synthetic crops use a trusted local
owned write boundary: temporary complete file, fsync, atomic hard-link publish,
identical-byte replay only, and no-follow canonical session directory descriptors.
Hashed render segment files use streamed immutable publication/comparison at the
same boundary. Full preview, JPEGs, proxy/audio/keyframes use signed HTTP PUT and
retain their documented mutable semantics. No check-then-PUT immutability claim.
No web upload/storage implementation was edited.

Private backwards-compatible service extensions (SPEC updated; normal generators
run, no handwritten generated files):

- `/svc/jobs/sandbox`: optional `leaseOwner` and `expectedAttempt`, checked in the
  registration mutation before writes. Local client always supplies both.
- `/svc/jobs/fail`: optional same guards plus `staleOnly`; mismatches are no-ops.
  Staleness is rechecked atomically against fresh lease/heartbeat values using
  server `HEARTBEAT_STALE_S`. A stale snapshot cannot fail a refreshed or another
  owner's attempt. Legacy service clients retain their existing behavior.
- Service claim's existing HTTP 204 is decoded as JSON null by the shared bounded
  transport. Worker response models still reject null where not allowed.

No public stage JSON Schema changed; generator refresh only updates validation
source digests. No `/worker/cost`, global atomic paid ledger, arbitrary-write
endpoint, requeue endpoint or approved-snapshot API was invented.

## Process ownership and recovery

The independent guardian owns a never-reaped group leader, watches owner socket
EOF and the immutable hard deadline, sends TERM then final KILL before reaping,
and retains its cross-process flock through cleanup retries. The owning Python
process only sends stop over its private socket and reaps its guardian; it never
signals a persisted PID. Cleanup confirmation is a durable UUID-bound receipt.
Success, runner crash, init/registration failure, stale heartbeat and hard timeout
all unwind through termination. In-memory failed handles remain reserved for
retry. Startup/periodic sweeping delivers only confirmed receipts; lost release
responses retry precisely the same immutable tuple. Unknown rows without local
proof remain unreleased, never guessed dead. All cooperating instances must share
the same state directory on a local filesystem.

The host fails closed on job attempts other than the first and durably admits a
job only once. No automatic requeue: the existing job projection omits incomplete
attempts and accumulated budgets, so restarting arbitrary attempts is unsafe.
Completed-output reuse and new-tap missing-moment policy remain in the unchanged
DAG; a fresh subject-retrack job can read prior immutable outputs. `NoPaidLedger`
rejects any nonzero reservation; the fixed host worker registry has no vendor
transport. Paid retry/ledger integration stays partial.

## Evidence and honest limits

`scripts/local-runtime.test.ts` launches the real `python -m netsense_orch --once`
process over a local HTTP bridge to **real convex-test HTTP routing/transactions**,
actual Next signing/media exports and the real local storage adapter. It generates
a synthetic clip, runs real transcode/check/render with fixture-backed model
stages, persists real outputs, asserts waiting_for_coach and exactly one release
row, probes H.264/AAC preview and JPEG headers, and checks persisted tracks contain
only the tapped fixture subject. This is stronger than a protocol fake, but is
**not** live Convex, browser uploader/student E2E or a paid/vendor test.

Python lifecycle failure tests explicitly use an in-memory **service protocol
fake** with real child processes. Driver tests exercise owner death, independent
hard timeout without polling, cross-process duplicate names, descendants,
registration/init unwind, retained cleanup retry and no late numeric signalling.
HTTP lifecycle tests exercise atomic owner/attempt/stale guards on real
convex-test mutations. Storage tests cover competing immutable writers, traversal,
symlinks, streamed byte limits, total deadline, redirect, missing/expired media,
actual PUT, and refusal of nonzero spend.

T1.09/T1.11 remain **PARTIAL**: no Modal implementation/live test, paid stages,
paid recovery, agent traces/cost endpoint, stage_retry/remark_retrack/finalize,
full browser M1 E2E, or deployed Convex/R2 behavior is claimed. Vendor behavior
remains **UNTESTED**. No `pnpm e2e` script exists yet. Trusted local processes must
not escape their owned process group; hostile code, external guardian kill,
power loss, state-directory destruction and multi-host/network-filesystem
semantics are outside this local-development guarantee. Missing durable cleanup
proof stays pending for diagnosis. Large-file/resource performance is unmeasured.

Final validation results follow below once all checks and the actual commit hook
complete. Disposable logs/builds stay ignored in `.orca-scratch/`.

## Validation

- `pnpm check`: passing lint, both strict TS projects, **336 JS tests / 30 files**,
  Ruff, strict mypy (**92 runner / 12 orchestrator files**), **391 runner tests**,
  **42 orchestrator tests**, 34-contract drift, six model-output schema limits
  and offline Convex bindings. The final clean-log run is recorded before push.
- `pnpm exec vitest run scripts/local-runtime.test.ts convex/tests/http-lifecycle.test.ts`:
  **67 passed**, including the actual subprocess-to-Convex/Next integration.
- `uv run --project services/orchestrator pytest services/orchestrator/tests -q`:
  **42 passed**, repeated after the absolute monotonic guardian deadline change.
- `uv run --project runner pytest runner/tests/test_host_storage.py -q`:
  **8 passed**.
- `pnpm contracts:gen` and `pnpm convex:codegen`: passed; generated manifest refreshed.
- `uv build --project runner --out-dir .orca-scratch/dist-runner` and
  `uv build --project services/orchestrator --out-dir .orca-scratch/dist-orch`:
  both sdist and wheel builds passed.
- `pnpm --filter @netsense/web build`: passed, including worker-sign and media routes.
- `scripts/secret-scan.sh`: passed, actual gitleaks history and source scans;
  installed with repository checksum verification inside `.orca-scratch/tools`.
- `uv tool run --from pre-commit==4.7.0 pre-commit run --all-files`: passed.
  The real staged commit hook is required and runs again on the commit, without bypass.
- `git diff --check`: passed. No browser E2E or live vendor test was run.
