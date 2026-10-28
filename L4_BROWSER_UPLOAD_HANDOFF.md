# L4 browser upload client handoff — T1.06 partial

Corrective task on PR19, based exactly on `6fb2909abfc343f00d19b7ae50ec4a872096e8da`.
Parent review builds on integration `c2cea96518bd237db98fa984771c83d7d71d8212`.
No server handler, Convex, contract, SPEC, runner or orchestrator changes.

## Exports and UI integration

- `sha256Blob(blob, { chunkSize, signal, onProgress })` hashes bounded slices
  (default 1 MiB, maximum 8 MiB); validates source lengths and cancellation.
- `MultipartUploadController` takes coach/session IDs, the picked File/Blob,
  transport and recovery store. Files must match the server's supported MIME and
  1..5 GiB size bounds. Concurrency is 1..32 (default 2). Retry delays default to
  2/8/30 seconds, at most ten delays, each at most 60 seconds.
- `createUploadTransport(fetcher?, { timeoutMs?, putTimeoutMs? })` implements
  the five existing POST endpoints and signed PUT. Defaults are 30 seconds for
  APIs and 120 seconds for PUT, including headers and streamed response bodies;
  configurable deadlines are positive integers up to ten minutes. The controller
  additionally bounds each operation to 120 seconds and owns its abort signal.
  A longer transport setting does not extend that controller ceiling.
- API responses are closed objects with closed nested entries. Bodies are bounded
  to 32 KiB of UTF-8 bytes while reading, with stream cancellation, timer/listener
  cleanup and no raw server/fetch errors surfaced. PUT uses `credentials:"omit"`
  and `redirect:"error"`; URLs reject credentials, fragments and unsafe schemes.

After the existing consent call succeeds, subscribe through `onEvent` and call
`start()`. Render `snapshot.confirmedBytes / bytesTotal`. `/parts/confirm` returns
**cumulative** bytes, which can arrive out of order; it is not a per-part byte
count. The controller validates aggregate bounds and counts each acknowledged
part once locally. Init must describe exactly `ceil(file.size / partSize)` unique,
bounded parts; readiness requires every verified part and the full byte total.
Snapshots and their part arrays are frozen.

Screen 08 calls `pause()`; `resume()` rehashes and re-initializes against server
`resumeFrom`. Retry waits and all active operations abort on pause/failure.
A part failure invalidates the run and drains sibling controller tasks before
`start()` settles. Every continuation checks its generation before another
network operation; even an injected PUT that ignores abort cannot send a late
confirmation. Injected transports must also honor their supplied signal to stop
underlying I/O; the controller observes late settlements without continuing them.

Call `complete()` whenever state is `ready_to_complete`, including **before the
subject tap** when the phone needs the post-upload selection-frame fallback.
Do not add a tap prerequisite: the server gates job creation. Success returns
`{jobId:string|null}`; `null` means successfully uploaded and waiting for the tap.
Failure **rejects**, emits no complete event and records `failed`; resume/re-init
then complete retries server completion safely after a lost response. `CONSENT_REQUIRED`
is preserved in transport errors and controller `snapshot.error` so screen 06
can untick the checkbox. UI routing and selection-frame extraction remain parent
work; this change does not implement either.

Only the UI's confirmed cancel action calls `cancel()`. The state becomes
`cancelling` immediately; concurrent cancel calls share a promise, and
start/resume/complete cannot race it. Cancellation succeeds only after the
server abort succeeds. Failure rejects and leaves `cancel_failed`; call
`cancel()` again to retry. A server completing reservation can reject abort;
no successful cancellation is claimed. Use a fresh controller plus the same
source to recover a completed upload in that case. `dispose()` aborts work,
clears listeners and permanently sets `disposed`; it does not imply server abort.

## Recovery and limits

Recovery is scoped to coach/session and contains only version, SHA, MIME, byte
size and optional upload ID. **API change:** `UploadRecovery.uploadId` is optional
while init is uncertain. Source identity is saved before init, so a lost init
response can be reconciled using the server's idempotent reservation, including
on reload. Cancel reconciles an unknown ID before aborting. Failed/uncertain
cancellation retains recovery; only confirmed abort or completion clears it.
A re-picked source is rehashed and mismatches fail with `UPLOAD_CHECKSUM`.

Recovery records are closed and bounded; storage getter, quota and security
exceptions cannot break controller transitions. If browser storage is unavailable,
recovery works within the live controller but cannot be promised across reload.
No signed URL, credentials, part URL, filename or media is persisted.

Whole-upload failure attempts remain in memory only. The five-endpoint backend
has no persisted failure-attempt contract; cross-reload enforcement remains an
explicit gap. R2/live vendor behavior remains **UNTESTED**. Full T1.06 and T1.37
remain **PARTIAL**: consent/progress UI, real login and Playwright/M1 E2E are
outside this task. No `pnpm e2e` script exists at this base. No real media,
credentials or vendor calls were used.

## Acceptance evidence

- `pnpm exec vitest run apps/web/lib/upload`: **81 tests passed** (including
  13 original client tests, 48 focused regressions, four new integration tests
  and 16 existing handler tests). All six parent reproductions are covered.
- New integration tests use the exported controller/transport, actual Next POST
  and signed local PUT handlers, actual ConvexHttpClient, convex-test HTTP bridge
  and real disk storage. Only Clerk and the network boundary are test seams.
  They upload two actual 8 MiB parts plus a remainder, retry lost PUT/confirm
  responses after persistence, resume without new PUTs, retry lost completion,
  check real jobId/null for both tap orders, and verify real cancellation,
  consent rejection and closed response validation.
- Focused regressions cover cumulative and out-of-order confirmation responses,
  malformed metadata, abort-ignoring PUTs, sibling failure, cancellation races
  and uncertain init recovery, permanent disposal, immutable snapshots, storage
  exceptions, strict response shapes, endless/slow/oversized UTF-8 streams,
  header/body/PUT deadlines and caller abort cleanup. SHA boundary lengths
  0, 1, 55, 56, 63, 64, 65 and randomized chunks match trusted Node crypto.
- `pnpm check`: PASS — lint, strict TypeScript, **398 JS**, **383 runner**,
  **33 orchestrator** tests, 34 contract drift checks, six structural schema
  checks and offline Convex bindings. The reported existing orchestrator
  PID-file timing flake did not reproduce.
- `pnpm --filter @netsense/web build`: PASS — optimized production build.
- `scripts/secret-scan.sh`: PASS — history and working source, no leaks.
  Installed the pinned checksum-verified gitleaks using the repository script.
- `git diff HEAD --check`: PASS.
- `git hook run pre-commit`: PASS — actual staged gitleaks hook; the commit
  also runs that hook without a bypass.

## Parent acceptance

The parent verified the six original reproductions and real-backend coverage,
then added a regression for a transport deadline during a part PUT. Such a
timeout now uses the bounded retry schedule while the current run owns the
upload; pause/cancel/dispose still invalidate the run and cannot retry. The new
test failed before the fix and passes afterward.

Final parent `pnpm check`: **399 JS, 383 runner, 33 orchestrator tests passed**,
including **82 upload tests**, lint/typechecks, contract drift and offline Convex
bindings. Full browser upload-to-student E2E remains pending.
