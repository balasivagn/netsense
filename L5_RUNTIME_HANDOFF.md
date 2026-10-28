# L5 executable local runtime — T1.09 / T1.11 PARTIAL

Correction starts exactly at parent-reviewed/pushed
`796d7a3a86d025592a49ff67be8cd929b5135688`; PR20 remains on
`lane/l5-local-runtime`. Parent integration remains separate and excludes PR20.
No subagents, other checkouts, paid calls, real-person media, web UI, provisioning
or deployment. Narrow authorized upload admission/reservation cap edits are included.
Parent subsequently integrated browser uploader PR19 at
`9411703396439b2c91206ec74c2bd8c053e457c4`; this branch excludes it. Its client
files are untouched. The subsequent parent integration below aligns PR19 with this local
server/runtime 2 GiB cap.

## Executable path and commands

From this repository root, after `pnpm install` and `uv sync --project
services/orchestrator`:

```sh
pnpm orchestrator --once
pnpm orchestrator
uv run --project services/orchestrator python -m netsense_orch --once
```

The first/third command claim at most one job. The second polls serially and runs
startup/periodic reconciliation between jobs and during long jobs. The actual child command is the
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
The local upload admission handler and private Convex reservation both reject
above 2 GiB, matching the host transport; metadata-only tests accept exactly
2 GiB and reject 2 GiB + 1 before storage/DB writes. Larger-file support remains
unsupported / UNTESTED. No browser upload client or public response shape changed.

Cached-object existence uses the trusted scoped local regular-file boundary,
avoiding a signer GET on missing objects. Existing cache bytes still traverse
actual Next signing/media for validation. An observed, fully downloaded corrupt
derived segment is quarantined under a directory flock only if its file identity
is unchanged, then rebuilt with normal immutable publication. JSON artifacts
remain immutable; reads/replay comparisons are bounded to 1 MiB, no-follow and
regular-file checked. Artifact I/O shares the actual stage deadline; expired
budgets reject without clamping. Segments retain streaming media limits.

Private backwards-compatible service extensions (SPEC updated; normal generators
run, no handwritten generated files):

- `/svc/jobs/sandbox`: optional `leaseOwner` and `expectedAttempt`, checked in the
  registration mutation before writes. Local client always supplies both.
- `/svc/jobs/fail`: optional same guards plus `staleOnly`; mismatches are no-ops.
  Staleness is rechecked atomically against fresh lease/heartbeat values using
  server `HEARTBEAT_STALE_S`. A stale snapshot cannot fail a refreshed or another
  owner's attempt. Legacy service clients retain their existing behavior.
- `/svc/jobs/control`: required `{jobId, leaseOwner, expectedAttempt}` returns
  exactly `{decision}` with closed `continue|stopped|terminal|superseded|missing`.
  The atomic mutation rechecks fresh heartbeat/lease, ownership/attempt, terminal
  status and current session job. Only `stopped` fails the exact current attempt;
  terminal/superseded/missing release only the caller's live owned handle. A fresh
  heartbeat returning `continue` preserves that child. Errors retain the worker
  under its independent guardian deadline. Existing `OkResponse` wires stay exact.
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
responses retry precisely the same immutable tuple. Reconciliation uses a
nonblocking cross-process flock and unique temporary files, bounds/no-follows
journal reads, checks canonical UUID, environment/service origin and matching
local job/name, and continues other deliveries after malformed/foreign records.
There is no unscoped global stale-list failure policy. Only a confirmed local
receipt authorizes recovery failure of its original claim. Unscoped older journals
remain pending for diagnosis. Known owned live workers observe externally failed,
cancelled or superseded jobs through fresh control transactions and stop promptly.
Claim owner must match the lifecycle owner before any acquisition.

Watch/runner heartbeats honor `HEARTBEAT_S` (15 s default, finite 1–60, below
pinned lease); queue polling honors `ORCH_POLL_INTERVAL_MS` (2000 ms default,
100–60000); sweeps honor `SWEEPER_INTERVAL_S` (180 s default, 1–86400), including
during long jobs. Owned wait polling stays at 0.2 s without repeated service calls;
control HTTP calls have a five-second deadline. Busy reconciliation locks defer
to the next sweep, retaining receipts. Unknown rows without local
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
fake** with real child processes. Additional executable HTTP probes run actual
Lifecycle + owned sleep-forever children through real convex-test transactions:
stale observation then heartbeat refresh must return continue with no release,
then external terminalization releases; successful stale stop, cancellation,
external service failure and owner supersession release well before hard lifetime.
Actual Next cache replay covers unchanged inode reuse, missing rebuild and corrupt
quarantine/rebuild. Driver tests exercise owner death, independent
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

- `pnpm check`: PASS — **345 JS tests / 31 files, 395 runner tests,
  62 orchestrator tests**; ESLint, strict TS, Ruff, strict mypy (92 runner /
  12 orchestrator files), 34-contract drift, six model-output schema limits and
  offline Convex bindings.
- `pnpm exec vitest run scripts/local-runtime.test.ts convex/tests/http-lifecycle.test.ts
  convex/tests/upload-limits.test.ts apps/web/lib/upload/handler.test.ts`:
  **92 passed**. Real HTTP/Convex transaction + owned-process race/stop probes,
  actual Next cache reuse/missing/corrupt rebuild, and metadata-only local cap tests.
- `uv run --project services/orchestrator pytest
  services/orchestrator/tests/test_lifecycle.py -q`: **27 passed**.
- `uv run --project runner pytest runner/tests/test_host_storage.py -q`:
  **12 passed**, including early declared-source rejection without media work.
- `pnpm contracts:gen`; `pnpm convex:codegen`: PASS.
- `uv build --project runner --out-dir .orca-scratch/dist-runner` and
  `uv build --project services/orchestrator --out-dir .orca-scratch/dist-orch`:
  both sdist/wheel builds PASS.
- `pnpm --filter @netsense/web build`: PASS (production Next build).
- `scripts/secret-scan.sh`: PASS (actual history/source scans);
  `uv tool run --from pre-commit==4.7.0 pre-commit run --all-files`: PASS.
  Actual staged commit hook runs without bypass on the corrective commit.
- `git diff --check`: PASS. No `pnpm e2e` script exists; full browser E2E
  and live vendor tests were not run.

## Parent review correction / integration handoff

The blocking stale-snapshot finding is corrected by the closed transactional
control wire, with real HTTP transactions and owned-process regression coverage.
The session-based `ns-{kind}-{sessionId}` lock/name and guarded failure on **every**
observed runner exit, including zero without persisted `/worker/done`, are preserved.
Fresh heartbeat declines no longer kill. Externally terminalized and superseded
owned jobs stop; successor attempts stay untouched. Global stale rows no longer
allow unrelated local/Modal failures. Receipt reconciliation is serialized and
scoped; malformed or foreign journals remain pending without blocking good rows.

Automatic requeue stays disabled. Single new-tap/missing-moment policy is unchanged.
T1.09/T1.11 remain PARTIAL; full browser M1 E2E, live vendor behavior, paid budget
recovery, Modal, stage_retry and finalize remain UNTESTED/unimplemented as above.
PR20 stays draft for parent review; nothing is merged into the parent integration.
Parent alignment completed below: PR19 browser validation now matches the 2 GiB local cap.

## Combined parent acceptance

Parent reviewed the transactional control/reconciliation changes and integrated
PR19's browser upload controller plus PR21's capture controls. The controller,
recovery metadata and confirmed-byte response validation now all enforce the
same 2 GiB local cap as admission/reservation and the executable runner.
Two additional boundary regressions accept exactly 2 GiB and reject 2 GiB + 1
without allocating media or initiating hashing/network work.

`pnpm check`: PASS — **424 JS / 395 runner / 62 orchestrator tests**, strict
lint/type checks, generated contract drift and Convex checks. Production web
build, secret scan and `git diff --check`: PASS. The real commit hook runs on
the parent correction. Full browser upload → review → share → student E2E still
does not exist; live Clerk/Convex and vendor behavior remain UNTESTED. Automatic
requeue remains disabled for the documented incomplete-attempt recovery gap.
