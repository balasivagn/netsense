# Screen 07a selection frames — T1.35 PARTIAL, T1.05/T1.06 integration

Base: parent-reviewed `2b22319148d1a9649bf1a18e2bebfea2a5b1ed77`.
Branch: `lane/l4-selection-frames`. No subagents, additional checkouts, paid calls,
real-person media, runtime auth bypass, deployment or merge.

Implemented the approved selection-only exception through the actual coach route.
Local decoding remains the first path. Pick after upload waits for authoritative
completion; reload without a File requests server frames directly. Loading,
retry, retake, tap, confirm and explicit Refresh frames use the existing picker.
Remote frame geometry is learned from the loaded JPEG by TapTarget. Request cleanup
aborts stale work on navigation, logout/login or session scope changes through the
existing keyed provider. A coach stays on selection until a real job exists.
The camera-origin source resume correction is retained.

## API and setup

`GET /api/sessions/[id]/selection-frames`, no body/query. Existing
`getCoachRouteAuth` obtains the coach token; new Convex `selectionFrames.source`
checks ownership, consent and exactly one canonical completed local upload with
its immutable SHA/size. Rejects happen before opening storage. The read neither
writes DB rows nor enqueues jobs. Response, errors and precise limits are in
SPEC §10.2. Responses are no-store. The response contains real JPEG frame
indices, measured timestamps in milliseconds, width/height and 300-second local
signed URLs. Repeat the authorized request to refresh URLs; none are persisted.

Use the existing explicit local storage configuration and real ffmpeg/ffprobe on
PATH (tested with ffmpeg 8.1.2; square-pixel scale requires ffmpeg 8+). No new
credential. Optional blank/unset settings use defaults:

- `SELECTION_FRAME_COUNT`: 12, bounded integer 2–24.
- `SELECTION_MAX_DURATION_S`: 600, bounded integer 1–600.

Each request verifies the complete original stream against exact size and SHA in
private scratch before any tool/output/cache hit; source cap 2 GiB. Only
MOV/Matroska/WebM inputs via file/pipe are accepted. Scratch uses TMPDIR or ignored
`.orca-scratch/`; children receive only PATH/optional TMPDIR and fixed NODE_ENV.
No shell, source URLs/paths/keys/arguments from the client or inherited credentials.
Limits: 90-second total deadline; four active requests/outstanding auth operations,
two active extractions, one per source/config, no pending extraction queue;
one thread, 64 MiB maximum single tool allocation, 64 KiB diagnostics;
8192 per side/33,554,432 input pixels; 640×640 output bound; 1 MiB/JPEG, 8 MiB total.
Rotation and square-pixel normalization preserve display-relative normalized taps.
Sparse seeks emit actual decoded images and timestamps, never a full 2 fps transcode.

Keys live solely under `sessions/{id}/selection/{sourceSha}/v1-{count}-{durationCap}/`.
All frames are validated before per-object atomic publication. Only a successful
whole publication installs a completed process-local manifest with image hashes;
no partial manifest is returned. The bounded 64-entry cache revalidates source
and JPEG hashes; missing/corrupt derivatives rebuild. Process restart regenerates
from source; no in-memory File is needed. Partial publication on disk failure may
leave unsigned JPEG objects without a completed manifest; retry rebuilds them.
Existing single-web-process local storage assumption applies. No durable cache
manifest or multi-process cache coordination is claimed.

## Acceptance evidence and test boundaries

`apps/web/lib/selection-frames/handler.test.ts` exercises actual Next GET, actual
ConvexHttpClient over controlled HTTP delivery to real convex-test query and
completion transactions, real LocalVideoStorage, actual local media GET and real
ffprobe/ffmpeg. Synthetic clips are generated only inside test scratch; runtime
loads no fixtures. It decodes emitted JPEGs with ffprobe, checks actual timestamps,
landscape and display-matrix portrait geometry, nonzero source start-time normalization, cache reuse/repair, overlap busy
response, signed media expiry, source size/SHA tampering and symlink rejection,
auth/foreign/consent/incomplete/aborted/closed-input denial before storage,
malformed media, tool failure, cancellation and private scratch cleanup. A real
long-running ffmpeg deadline test and cancellation during actual handler ffmpeg
both assert SIGKILL, reaping (PID no longer exists), and no residual scratch.
Stalled source I/O is a controlled Readable test seam and is destroyed on abort.

Before confirmation, tests assert no jobs, stageRuns, transcriptTurns or annotations
and no audio/proxy/analysis directories; only source/selection exist. The exact
single coach-selected subject is persisted through existing `sessions.setSubject`;
repeating it returns the same sole job. Existing tests retain both gating orders.
No pipeline/model call obtains these selection frames.

`convex/tests/selection-frames.test.ts` focuses on the owner-only read, absent auth,
complete-only admission, inconsistent metadata, consent and exactly-once enqueue.
`apps/web/components/sessions/routes.test.tsx` renders real route composition and
SubjectPicker with real Convex transactions, controlled Clerk/router/query/media/
upload/selection-fetch seams. Added reload without File, safe retry/remote tap,
one queued job, and late logout response cleanup. These are unit/integration
harness tests, NOT browser E2E. Existing upload handler/runtime tests still run.

## Remaining gaps

T1.35 stays PARTIAL: review/change-who-to-follow and later retrack entry points are
outside this slice. Playback/review/share/student, runner recovery, R2, paid APIs,
deployment and full browser M1 E2E are unchanged. No `pnpm e2e` command exists.
Live Clerk/Convex browser/deployed behavior and resource performance remain
UNTESTED; no credentials or real footage were used. ffmpeg resource limits bound
this trusted local binary; they are not an OS sandbox against a compromised codec.

Final validation is recorded below after completion.

## Final validation

- `pnpm check`: PASS — **459 JS tests / 40 files, 395 runner tests,
  62 orchestrator tests**; ESLint, strict TypeScript, Ruff, strict mypy
  (92 runner / 12 orchestrator files), 34-contract drift, six model-output
  structural checks and offline Convex bindings.
- `pnpm exec vitest run apps/web/lib/selection-frames/handler.test.ts
  convex/tests/selection-frames.test.ts apps/web/components/sessions/routes.test.tsx`:
  **20 passed / 3 files** (8 real-tool/handler, 2 Convex, 10 route composition).
- `pnpm --filter @netsense/web build`: PASS — optimized production build,
  including `/api/sessions/[id]/selection-frames` and existing coach routes.
- `pnpm contracts:gen`; `pnpm convex:codegen`: PASS — documented generators;
  only the new Convex module binding needed a generated diff.
- `scripts/secret-scan.sh`: PASS — history and working source scans, no leaks;
  pinned checksum-verified gitleaks installed via `scripts/install-gitleaks.sh`.
- `git diff --check`; `git diff --cached --check`: PASS.
- `git hook run pre-commit`: PASS — actual staged secret hook. Commit also runs
  the installed hook without bypass.

No `pnpm e2e` script exists, and no full browser M1 or live Clerk/Convex/vendor
validation is claimed. Review this lane's incremental diff against the base above;
the draft PR to main also carries that parent integration ancestry.

## Parent review

The parent added a bounded browser response adapter: 32 KiB total, 100-second
header/body deadline, no redirects, closed frame wire with count/order/time and
geometry checks, session-scoped local media URL validation, and cancellation of
late response bodies. Malformed or stalled responses now reach the existing safe
retry state. Five regression tests cover these boundaries; route composition uses
the complete real response shape.

Parent `pnpm check`: PASS — **464 JS / 395 runner / 62 orchestrator tests**.
Production web build, contract drift, secret scan and diff check PASS. Actual
commit hook runs on the parent correction. Browser/live Clerk/Convex E2E remains
UNTESTED, and review/retrack entry points still belong to subsequent work.
