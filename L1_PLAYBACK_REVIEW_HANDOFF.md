# L1 playback/review — T1.23 and T1.24 PARTIAL

Base: reviewed `0b19bf987c96f82baa375cb94308f89fbea491f8`, available on
`origin/lane/l4-selection-frames`. Branch `lane/l1-playback-review`; draft PR targets
main and retains the reviewed parent ancestry. Review the incremental diff against
that exact base. No merge, paid/live APIs, child delegates, additional checkout,
real-person footage or auth bypass.

## Connected routes and interfaces

- `/sessions/[id]/playback`: screens 17/18, actual persisted remarks/turns/marks/
  tracks/render/source artifacts. Current preview first; stale/missing/failed/
  undecodable preview falls back to proxy + live canvas, never both overlays.
  Native proxy geometry matches the shared numeric Python fixture; safe nearest
  observations do not bridge gaps or the first swap. Only the exact bound selected
  subject draws. Remark timeline seeks actual moments and uses placement shape.
- Original voice excerpts use source `audioM4aKey` and original turn spans, skipping
  inter-turn gaps, stopping on span endpoint, another excerpt, navigation or scope
  change. Typed remarks have no audio control. Corrected text stays separate.
- Still mode keeps a permanent banner, actual persisted still strip with seeking,
  and unmarked video action. Invalidated/missing stills are unavailable rather than
  fabricated or shown as tracking.
- `/sessions/[id]/review` and `/review/[annotationId]/move`: owned cards with verbatim
  quote/time, role/mode/status, placement shape/label, Why here, per-item approve,
  edit/type/neutral label/anchor/arrow/retime, delete/undo and transcription correction.
  Full mode is default; `FEATURE_REVIEW_MODE=simple` limits controls to individual
  approve/delete and retiming. Actual lesson drafts supply suggestion counts/cards.
- `convex/playback.ts`: closed owner projection, verifies joins and current-subject
  bindings against completed track-run receipts; no private worker provenance,
  models, tokens, traces or config. Completed transcode may come from an earlier
  owned job, as required for a subject-retrack. Source receipt hash binds metadata.
- `convex/review.ts`: transactional single-ID mutations, generated enums, pinned
  allowlist/label cap, existing UTF-16/word boundaries, finite integer in-moment
  time bounds, role/owner/current track/coverage/check guards. Original words,
  AI placement and provenance survive. Placement edits become coach drafts;
  undo never silently restores approval. Workers' existing retry protections stay.
- `POST /api/media/sign`: existing `getCoachRouteAuth`, actual Convex owner query,
  bounded local artifact read + generated TranscodeOutput/receipt verification.
  Closed assets: proxy/audio/current preview/still annotation/current remark track.
  No arbitrary key, prefix-based grant, student/public access or write endpoint.
  TrackFile bytes are schema/semantic checked before returning a GET URL plus
  validated JSON; browser repeats validation. Limits/response wire are in SPEC.
- Status/list completion reaches real playback; RENDER_FAIL can use live overlay.
  Review's Change who to follow enters the real SubjectSession. Terminal jobs no
  longer redirect or block selection-frame reads. Running/queued jobs remain gated;
  only a confirmed tap's returned job navigates to status. Existing setSubject
  owns reset/preservation/exactly-once enqueue and missing-moment DAG policy.

## Deliberate partial boundaries

T1.23's implementation is connected; required browser/device acceptance remains
UNTESTED. No `pnpm e2e` exists. Unit/integration harnesses are not browser E2E.
Live Clerk/Convex setup, R2, browser/Pillow text rasterization/font/visual parity,
mobile playback/audio behavior, and deployment resource behavior remain UNTESTED.

T1.24 stays PARTIAL. A retime saves a real single-item draft but cannot inherit
approval from its original checked range. Convex has summary coverage and a track
reference, not validated frame observations; atomic local-byte/range verification
must be connected before approving another range. The backend rejects that
approval and the UI disables it. Reverting to the checked range or choosing note
only is available. Existing checked-range anchor/type changes can be approved.
There are numeric retiming controls, not drag/±0.5s controls. No bulk endpoint.

Suggestion approval/dismissal, free notes/focus/practice editing (screen21), sharing,
student, finalize and typed/per-remark recovery execution are next lanes. Actual
suggestions are visible, with no fake save/dismiss controls or missing-route links.
A remark without any placement shows an unavailable state; it creates no invented
mark or recovery job. Missing tracks permit note-only on existing marks; still
choice is available only with a real binding/keyframe. Retiming or editing still
marks invalidates old stills and needs later rendering to produce new marked JPEGs.
Final media signing stays unavailable until finalize has an approved snapshot.

## Evidence

Focused tests use actual persisted worker outputs through convex-test HTTP
transactions, not a runtime fixture fallback. Media handler tests run the actual
Next POST, actual ConvexHttpClient over controlled HTTP delivery to real owned
transactions, actual local storage and media GET, and generated ffmpeg MP4/audio
from a recipe under fixtures/synthetic. They cover foreign/unauthed/arbitrary
assets before storage, closed requests, expiration, missing files, corrupted/
oversized artifacts/tracks and symlink rejection. No production fixture import.

Geometry tests consume the same synthetic JSON fixture as Python and cover
non-square letterboxing, rounding, arrowheads, half-open times, nearest-frame
ties, gaps, swaps, still observations and selected-subject binding. Route tests
compose actual layout/pages/components with controlled Clerk/query/media seams:
preview/no-double-draw/stale/live and decode-failure fallback, still strip/banner,
seek/callback cleanup, approve/edit/delete/undo/correction, original audio stop,
retap after anchor failure, simple mode and late scope responses. These are NOT
live websocket/browser E2E. Existing worker persistence retry tests remain green.

Final validation results follow below after completion.

## Final validation

- `pnpm check`: PASS — **492 JS tests / 46 files, 395 runner tests,
  62 orchestrator tests**; ESLint, both strict TS projects, Ruff, strict mypy
  (92 runner / 12 orchestrator files), 34-contract drift, six structural model
  schema limits and offline Convex binding checks.
- `pnpm --filter @netsense/web build`: PASS — optimized production build includes
  playback, review, dedicated move route and authenticated coach media signing.
- `pnpm contracts:gen`; `pnpm convex:codegen`: PASS; no stage contract redesign or
  runner changes. Only new module bindings changed in generated output.
- `scripts/secret-scan.sh`: PASS — real history and working-source scans with the
  checksum-verified pinned gitleaks installed by the repository script.
- `git diff --check`; `git diff --cached --check`: PASS.
- `git hook run pre-commit`: PASS — real staged secret hook; commit also invokes
  the installed hook without bypass.

The final video cleanup regression asserts that unmount removes the old source,
not merely that canvas callbacks stop. The direct account-switch test hides a
cached projection using its authenticated owner identity stamp. Full checks and
production build were repeated after that correction. No browser E2E/live vendor
validation is claimed, and T1.24 remains partial for the boundaries above.

## Parent review corrections

Three failing reproductions now pass:
- Switching between coach-word spans and neutral labels clears the old optional
  source before validation, preserving original AI placement/provenance.
- A per-remark mode change clears approvals on all affected non-deleted sibling
  marks. No sibling is approved by the operation; the edited mark is coach-placed.
- Hear coach's endpoint timer checks the media clock and pauses while buffering,
  so elapsed wall time cannot skip unheard original speech.

Parent `pnpm check`: PASS — **495 JS / 395 runner / 62 orchestrator tests**.
Production web build, contract checks, secret scan and diff check PASS; actual
staged commit hook runs on the parent correction. Retimed-range verification and
approval remains pending; browser E2E/live Clerk/Convex remains UNTESTED.
