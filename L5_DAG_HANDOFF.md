# L5 core runner DAG — T1.09 PARTIAL

Base: `0b7129cac5610384511245646176c14ee8168c4c` from the parent's local
integration branch, merged with worker client `ebe456f`. The client transport
repair on PR #12 remains the parent's responsibility; this lane does not change
`clients/`, HTTP client tests, server code, generated contracts, dependencies,
or orchestration. No subagents, paid keys, real-person media, or vendor calls.

## Callable boundary

`netsense_runner.dag.Runner(...).run()` returns an `Outcome` with terminal local
status, safe error code, and per-branch errors. `netsense_runner.__main__.main(runner)`
returns a process exit code. Unconfigured `python -m netsense_runner` fails closed
with `RUNNER_DEPENDENCIES_REQUIRED` / exit 78. It does not invent storage signing,
credentials, providers, or a production bootstrap.

The host supplies:

- `client`: `ConvexWorkerClient`, or an implementation of the explicit typed
  `persistence.WorkerClient` protocol. The protocol matches the reviewed start,
  finish, heartbeat, done, and nine persistence methods. No generic persistence,
  usage-report, `/worker/cost`, or signing route is called. `StageContext.convex`
  now exposes only the real heartbeat capability; workers return their outputs.
- `artifacts`: `Artifacts(session_id, store)`, where `store.read(key)` raises
  `FileNotFoundError` for missing data and `put_new(key, bytes, content_type)`
  atomically rejects changed existing bytes. Use a host implementation over the
  existing storage capability; reads and writes must bound their blocking I/O.
  `storage` separately implements the existing `WorkerStorage` interface for
  tool workers. Artifact reads/writes stay under `sessions/{sessionId}/`.
- `budget`: a fresh `Budget` constructed from this job's pinned limits and an
  injected atomic `DailySpendLedger`. Every paid/tool worker must reserve frames,
  tokens, and spend **before** work through this shared Budget, as the existing
  adapters do. The DAG does not charge reported usage a second time. Fake usage
  is zero cost; there is no nonexistent cost endpoint or local-only substitute
  for the global atomic ledger.
- `workers`: a copied-at-construction mapping from `(workerId, inputContract)`
  to `factory(remark_number | None) -> StageWorker`. IDs, worker types, input and
  output contracts must match enabled pinned config. Both subject workers use
  the same pinned subject ID: `SubjectAnchorInput` distinguishes the anchor from
  `SubjectInput`. A rules factory should construct
  `CheckRulesWorker(artifacts.read, CheckerConfig(pinned coverage/label caps),
  session_subject_role, remark_number)`; the ordinal is over **all** session
  remarks, ordered by time then UTF-16 lexical remark ID, including note-only
  remarks outside the current plan. The only recognized screen fallback is
  render's existing `live_overlay`; no alternate paid worker is substituted.
- `providers`, scrubbed `log`, and `cleanup()`: cleanup releases only resources
  owned and registered by this execution. No Files API transport is implemented
  or claimed. A vendor worker must register its own uploaded file cleanup and
  retain its own `finally` cleanup too. Clock, backoff wait, cancellation Event,
  and heartbeat interval are injectable.

The tests construct the actual typed client with only `_request` transport
replaced; they validate lifecycle request shapes, schema-validate persistence
payloads, enforce persist-before-finish, and return distinct actual annotation
IDs. This is not a live Convex transaction/E2E test; the server's existing
transaction tests own that evidence.

## Runtime behavior

Normal jobs execute transcode → transcription → plan → new subject anchor, then
bounded per-remark moment → subject → track → place → check, followed by preview
render after every branch is terminal. Other-person/general remarks are persisted
by plan with no branch; unclear remains explicitly `aboutSubject=unclear` and
runs the tracked branch. AI placement remains unapproved through the existing
persist/marks behavior; there is no approval operation in the runner.

`validate_contract` checks authoritative JSON Schemas before worker invocation,
after worker output, after code-owned text projection, and before artifact
storage. Result status/error/usage also crosses the authoritative StageRun
schema, with finite/safe-integer usage and finite JSON checks. Original transcript
text is copied in code for plan coachWords and UTF-16 label spans. Label spans
cannot split surrogates or Unicode letter/number/mark/underscore words, and long
spans trim inward to a whole-word boundary at the pinned cap (at most 60 UTF-16
units). Invalid spans fail safely. The server still byte-compares on persist.

Input JSON is UTF-8, recursively sorted object keys, compact separators, preserved
array order, `ensure_ascii=False`, and no nonfinite numbers. `inputHash` is its
SHA-256. The SPEC 6.2 identity joins the **JSON encodings** of jobId, stage,
remarkId, workerId, inputHash with ASCII `|`, then SHA-256 hashes those bytes.
Null remark IDs encode as JSON `null`, not an empty string or the string `"null"`;
JSON quoting keeps embedded separators unambiguous. No random worker IDs enter
this identity. SPEC 7.5 cacheKey is SHA-256 of canonical
`[proxySha256,[windowStartMs,windowEndMs],[mode,promptFrameMs,promptBox,promptPoint],downsampleFps]`.

Each attempt uses the actual API-returned stageRunId and sequential attempt
number. Retry limits and timeoutMs come from pinned config; waits are 2s then 8s.
A worker receives the lesser of its stage deadline and the calculated job deadline
(capped by sandboxTimeoutCapS). Execution is cooperative: Python threads are
**not** forcibly stopped. Late results fail STAGE_TIMEOUT before persistence;
tool workers own subprocess cleanup. Pool join waits for in-flight workers before
resource cleanup; a worker or injected transport ignoring its deadline can delay
this. Cancellation and heartbeat failure prevent further stage admission and
result persistence once observed. Budget failures stop further stage admission
and return a failed job with the actual budget code after branches settle.

Outputs persist before finish. The immutable output JSON is at
`sessions/{sessionId}/runs/{jobId}/{stageRunId}.json`; its immutable `.receipt`
sidecar binds actual run/job/stage/remark, pinned config/worker/model, input hash,
idempotency key, and marks' returned annotation IDs. Resume requires the exact
current-job identity, validated output, matching receipt, and existing referenced
media/track artifacts. It skips worker work, projection writes and charges.
Missing/invalid matching current-job artifacts fail closed rather than trying to
rewrite a completed row. All track files are schema-validated as subjectOnly.
Provenance contains the actual moment/subject/track/place run IDs and actual
non-null model versions. Render uses returned annotation IDs, includes only
checker-passing marks, and references the selected subject's track file.

`FakeWorker` is opt-in, fixture-backed and refuses unset, production-like or any
environment besides explicit `test` / `development`, both at construction and
execution. It is never registered automatically. Fixtures contain three visible
identities; the tap selects one and tracking discards other IDs. Lost-target
fixtures leave two bystanders visible and do not switch; jump fixtures are
rejected by the real rules checker. The fake render produces an explicitly named
`.render-test-stub.json`, **not video or T1.21**. Tests use the real ffmpeg
TranscodeWorker on a generated synthetic clip and the real CheckRulesWorker.

The heartbeat thread stops and joins in finally; `/worker/done` is attempted once
using supported statuses/codes. Owned cleanup still runs if worker, persistence,
finish, heartbeat, or done fails. Network failures may prevent delivery; the
runner reports failure rather than claiming successful completion. Error values
are fixed codes, never raw exceptions, coach words, URLs, tokens, or trace text.

## Approved subject_retrack recovery

A new tap always causes a new anchor. Completed transcode/transcribe/plan outputs
must exist and validate under the same pinned config/worker receipt. Missing
prerequisites fail `CONTRACT_INVALID`; nothing is fabricated or fully restarted.
Completed moments are reused by remark from the prior job, including when the
new tap changes the subject's role label. Only missing moments are computed,
**after** the new anchor succeeds. Subject/track/place/check/render from old jobs
are never reused. Only prior-job moment runs enter new placement provenance,
matching the existing server rule; upstream transcode/transcribe/plan outputs are
read as prerequisites and never re-persisted with invented current-job run IDs.

## Remaining gaps / UNTESTED

T1.09 remains **PARTIAL**, with these frozen-interface limitations explicit:

- `/worker/job` exposes completed runs only. There is no non-done (failed/running/needs_coach) attempt
  projection to recover a sequential attempt number after a process dies during
  a failed attempt or between persist and finish. This runner retries sequentially
  within an invocation and resumes completed artifacts. It does not invent a
  failed-attempt lookup, fabricate a done row, or claim arbitrary crash recovery.
- There is no general remark-failure projection endpoint. Failed branches finish
  their actual stageRuns and appear in `Outcome.branch_errors`; other branches
  and rendering continue. A pre-check failure may leave its remark projection
  pending rather than show screen 16/19 correctly. Check failures use the existing
  persist/verdicts projection. Unclear is preserved for existing UI interpretation;
  no new flagging endpoint is invented.
- `remark_retrack`, `stage_retry`, and `finalize` reject with existing
  `CONTRACT_INVALID`, before running stages. Frozen approved final-render inputs
  and recovery/approval APIs are pending; no approval logic is invented.
- Host startup wiring, durable storage adapter, global daily ledger backing,
  authenticated upload/signing routes, real stages 1–6, T1.21 renderer, screens,
  lifecycle/sweeper integration, and full app E2E remain other work. `pnpm e2e`
  does not exist yet. Clerk/Convex runtime configuration is still required for
  the app. Live Convex/storage/vendor/Files API behavior is **UNTESTED** here.
- Agent trace persistence and cost endpoints remain absent. No vendor/production
  configuration is automatically selected by this runner or its module entrypoint.

## Verification

- `pnpm check`: PASS — ESLint; strict TypeScript for both projects; **283 JS
  tests / 18 files**; Ruff; strict mypy **79 runner / 7 orchestrator files**;
  **224 runner tests / 33 orchestrator tests**; 34 generated contracts verified;
  six model-output schemas checked; offline Convex bindings verified.
- `cd runner && uv run pytest -q tests/test_dag.py`: **45 passed**. This includes
  normal full DAG; actual persisted annotation IDs/provenance; three-person tap
  selection; no/general note-only and unclear fan-out; caps 1/2; isolated branch
  failure; sequential retries with 2/8 waits; deadline rejection; frame/token/spend
  preflight; completed resume without writes/charges; missing/corrupt artifact and
  receipt rejection; unsupported-job safe boundaries; heartbeat stop;
  cancellation and network/persist/finish/done/cleanup failures; both missing-
  moment recovery cases and all-moment reuse; lost target; actual checker swap
  rejection; all-session numbering; UTF-16 copying, surrogate/word rejection,
  and inward 60-unit trimming.
- `scripts/secret-scan.sh`: PASS — real gitleaks history and task-source scans,
  no leaks. Installed via the repository's checksum-verified script under
  `.orca-scratch/tools` because it was absent from PATH.
- `uv tool run --from pre-commit==4.7.0 pre-commit run --all-files`: PASS — real
  gitleaks hook. The actual commit hook is also run, without bypass.
- `git diff --check`: PASS. Scratch logs, generated clips and tool downloads
  remain ignored and unstaged. No full app E2E or live vendor success claimed.
