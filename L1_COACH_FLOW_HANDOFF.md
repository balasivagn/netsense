# L1 coach route integration

Base: reviewed `3260f6c05e65c0048e4d71881aaaf80eede3de6a`.
Branch: `lane/l1-coach-flow`. No merge, deployment, paid/vendor call or auth bypass.

## Implemented boundary

Authenticated `/sessions`, `/sessions/new`, `/sessions/[id]/record`, `/upload`,
`/subject`, `/status` use the existing Clerk server/provisioning gate and Convex
identity. Screens 02–04 list actual owned sessions, filter, add a student label,
and require student + role. Screen 06 persists consent before accepting a source,
then persists the actual camera/camera-roll choice. Draft creation omits capture
mode; compatible existing callers can still supply one. Upload init/private
reservation reject an absent mode before creating storage. Mode cannot change
after a reservation. SPEC and generated manifest/bindings are updated.

`convex/coachSessions.ts` joins owner-scoped student/session/upload/latest-job
records and projects only coach-safe fields. Latest-job labels come from the
job's pinned config version; no active-config substitution, full config,
provider/model information, storage URLs, service credentials or job internals.
The status route subscribes through `useQuery`. CoachStages receives real rollup
values, with no fabricated stage completion or progress.

A coach/Clerk-session/session-keyed provider owns the File and existing
MultipartUploadController across record/upload/subject client navigation.
Scope changes/unmount dispose it and stale async operations cannot navigate.
Only existing SHA/MIME/size/upload ID recovery metadata and a pending failure
report generation can persist. No File, media, filename, signed URL or credential
is stored. Reload asks for the same source; selection is enabled only after
SHA/resume admission verifies it. Both upload-before-tap and tap-before-upload
work, including `complete.jobId === null`; real-time latest-job changes route to
status. Backend gating continues to enqueue once.

Upload progress comes only from acknowledged parts. Pause/retry use the existing
controller; cancel asks first and only claims cancellation after the server
confirms it. Exact CONSENT_REQUIRED at admission or init resets Screen06's
checkbox. The existing size, bounded transport, race, checksum and resume behavior
is retained.

## Durable failed attempts

Owner mutations issue/reuse one active whole-upload generation and accept at most
one failure report for it. Arbitrary totals, unissued/stale/duplicate generations,
foreign owners, and reports after completion/abort cannot change the count.
Three persisted failures show Upload failed and block new whole-upload admission
and reservations. An already admitted completion can recover; complete sources
can still be reselected. This is separate from per-part retry backoff, which is
unchanged. Pause, cancel and disposal do not count as failed attempts.

The browser reports observed whole-upload failure; the server cannot independently
observe browser network failure. A pending report is stored as one scoped integer
and flushed before the next attempt, including reload. If browser storage is
unavailable, or cleared before an offline report reaches Convex, delivery across
reload cannot be guaranteed. Convex remains authoritative for accepted counts;
there is no client-supplied total and concurrent reports are transactional.

## Pending integration and partial tasks

- T1.07 route implementation is present. T1.06/T1.37/T1.13 integration portions
  are present; browser/device acceptance remains UNTESTED. No `pnpm e2e` command
  exists at this base, and no mock/unit test is described as browser E2E.
- **T1.35 stays PARTIAL.** Local decode/tap/persist works. The approved fallback
  is selection-only extraction after completed upload, before the tap. No such
  extractor/signing/read projection exists yet. Pick after upload completes the
  upload and shows an explicit pending integration state. It supplies no invented
  frames and starts no analysis without a tap. The future boundary must provide
  real `selectionFrames` with timestamps to the existing SubjectPicker, only after
  an authoritative completed upload. Do not enqueue the pipeline to obtain them.
- Completion's eventual target is `/sessions/[id]/playback`. That lane is absent:
  status tells the coach processing finished and playback is unavailable, rather
  than sending them to a nonexistent route. Session rows likewise stay on status
  for jobs until playback/review/share routes land. No final playback/review/share
  or student UI was built. No automatic requeue.
- Error copy is rendered without working-looking no-op buttons. Retry-stage,
  manual/typed remark, still-frame recovery and per-remark retracking actions
  remain pending their lanes. Review/change-who-to-follow UI remains pending.
- Live Clerk/Convex browser testing requires user setup and remains UNTESTED.
  No paid keys are needed by these changes. Local fake providers remain explicit
  development/test configuration; the running web app loads no synthetic data.
- The layout targets mobile widths including 390px. Real-device/browser visual
  verification remains UNTESTED; no screenshot or browser E2E claim is made.

## Acceptance evidence

`apps/web/components/sessions/routes.test.tsx` renders actual route exports,
layout/context, Screen06CaptureControls, SubjectPicker and CoachStages, with real
convex-test transactions/projections. Clerk hooks, router, query delivery,
media decode and upload transport are controlled test seams. It covers consent
before upload, real student/role creation without an invented mode, both gating
orders, source lifetime through navigation, pinned live-status updates, fallback
pending copy, cancel confirmation, admission consent reset, and late account/
unmount completions. Query updates are explicitly delivered by the harness;
this is not a live websocket or browser test.

`apps/web/lib/upload/client-integration.test.ts` additionally exercises SessionFlow
with actual five Next upload handlers, actual ConvexHttpClient over an in-process
HTTP boundary, real convex-test HTTP actions/transactions, and actual local disk
PUT/assembly. Both gating orders yield one queued job and pinned stage labels.
Existing transport loss/resume/cancellation integration tests still run.

`convex/tests/coach-sessions.test.ts` covers owner/unauthenticated/foreign IDs,
foreign joined jobs, pinned labels despite active-config changes, draft capture
mode lifecycle, and race-safe durable failures. `flow.test.ts` covers acknowledged
progress, reload/resume, pending failure report replay, failed cancellation,
late PUT/admission/mode results and scope disposal.

Final validation:

- `pnpm check`: PASS — **446 JS tests / 38 files, 395 runner tests,
  62 orchestrator tests**; ESLint, strict TS, Ruff, strict mypy (92 runner /
  12 orchestrator files), 34-contract drift, six structural schema limits and
  offline Convex bindings.
- Final `pnpm exec vitest run apps/web/lib/session-flow/flow.test.ts
  apps/web/components/sessions/routes.test.tsx`: **15 passed**, including final
  pause/admission and terminal retry regressions.
- Final `pnpm exec vitest run apps/web/lib/upload/client-integration.test.ts`:
  **6 passed**, including real-handler missing capture-mode rejection before
  reservation and canonical-source mismatch rejection after completion.
- `pnpm contracts:gen`; `pnpm convex:codegen`: PASS (documented generators).
- `pnpm --filter @netsense/web build`: PASS — optimized production build with
  all six requested coach routes, route typing and static generation.
- Final `pnpm lint`: PASS.
- `scripts/secret-scan.sh`: PASS — actual history and working-source scans,
  checksum-verified pinned gitleaks installed through the repository script.
- `git diff --check`; `git diff --cached --check`: PASS.
- `git hook run pre-commit`: PASS — actual staged gitleaks hook. The commit also
  runs the installed hook without bypass.

The main-target PR inherits the reviewed runtime ancestry; review this lane's
incremental diff against `3260f6c05e65c0048e4d71881aaaf80eede3de6a`.
No browser E2E/live Clerk/Convex or paid/vendor validation is claimed.

## Parent review

A new route-composition regression reproduced camera-origin uploads failing on
camera-roll reselection after reload. RecordSession now preserves the reserved
source's original capture mode while the existing SHA-256 check still verifies
the chosen file. New uploads continue to persist the actual picker mode. The
regression failed before the correction and passes afterward.

Parent `pnpm check`: PASS — **447 JS / 395 runner / 62 orchestrator tests**.
Production web build, secret scan and diff check PASS; real staged commit hook
runs on the parent correction. Browser/live Clerk/Convex E2E remains UNTESTED.
