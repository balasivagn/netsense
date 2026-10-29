# L6 render corrective handoff — T1.21 / C15–C16

PR16 remains draft. Repair starts at `2e95ebab6afe83a16c3fedb2ae11dde26fc259e0`
and merges parent integration `9a5f5fa3cc37b7780cfd224288ac226db82b289a`.
Parent review now connects the DAG to shared segment construction and supplies the selected keyframe time. Host startup/registry wiring, final approval snapshots and T1.26 remain pending.

## Parent integration API

Use `media.segments.build_segments(annotations: list[RenderInput.Annotation], duration_ms)`.
It returns generated `Segment` models: merge gaps strictly less than 1000 ms, IDs
`s-{startMs}-{endMs}`, and SHA-256 of compact sorted UTF-8 JSON
`{startMs,endMs,annotations}` including **every** frozen annotation field. Separate
ranges retain their IDs when another range's content changes. The renderer checks
supplied ranges, membership and hashes exactly; the DAG now uses this builder. Incompatible supplied hashes are rejected rather than silently rewritten.

Construct `RenderWorker(download=..., track_loader=..., object_exists=..., font_path=...)`.
The injected I/O protocols now require explicit keyword bounds:

- `download(url, *, timeout_s, max_bytes) -> Iterator[bytes]`: enforce the total byte
  limit while reading and a deadline across **every** `next()` (including the first).
  Chunks must be bytes no larger than 1 MiB. Proxy/cache download limit is 2 GiB.
- `track_loader(ref, *, timeout_s, max_bytes) -> bytes`: enforce the limit during the
  read; tracks are at most 1 MiB, not a large response truncated after allocation.
- `object_exists(key, *, timeout_s) -> bool`: bounded object lookup.
- `ctx.storage.get_url` / `put_file` must themselves use bounded transport operations
  tied to the stage budget. Their shared interface has no timeout parameter; this
  remains a caller requirement. The renderer checks the deadline before and after.

A synchronous arbitrary injected callable cannot be forcibly interrupted here. The
bounds above are obligations of the adapter, not a claim that Python preempts it.
Subprocesses use the existing ToolAdapter deadline/process-group cleanup. All tool,
loader and storage failures return scrubbed StageResult codes; probe timeouts retain
`STAGE_TIMEOUT`. Local scratch is removed in `finally` on success, failure or timeout;
partially uploaded artifacts are not transactionally rolled back and never produce a
successful StageResult. There is no sandbox creation in this worker.

## Timing, resources and safety

Source metadata must be finite, within 30 minutes, 1–60 fps, even dimensions up to
1920×1080, and match requested duration within one frame (minimum 50 ms). Actual
presentation timestamps must form a zero-origin CFR grid within 1 ms. VFR input is
**explicitly normalized to 30 fps on its existing time axis**, re-probed and validated
before drawing. Mark windows stay half-open; fractional frame times are not rounded
before testing membership. Every cut uses the same global frame grid. Generated
segments are video-only H.264/yuv420p with 1/90000 timebase; final concat copies the
full source audio once, avoiding AAC re-encoding/padding at each boundary. CFR
non-aligned-cut tests assert 60 frames for two seconds, duration within 34 ms, faststart,
and decoded source/output audio equality. VFR normalization has a real ffmpeg test.

RGBA extraction uses batches of at most 30 frames, further reduced to keep estimated
decoded expansion below 256 MiB. Frames are deleted after each encoded batch; Pillow
retains one frame at a time. A 4 GiB aggregate scratch check bounds accumulated encoded
parts between batches/segments (it is not an OS disk quota and can overshoot during a
single external operation). A 30-minute performance/deployment resource benchmark is
UNTESTED; the shared 300-second stage deadline can still fail a large job safely.

Track validation rejects nonfinite/degenerate/out-of-frame boxes, empty/duplicate/
unordered observations, invalid fps, invalid or overlapping gaps, and invalid or
unordered swaps. fps=0 is valid only with one selected observation. Lookup does not
interpolate or bridge gaps, and never draws a gap/swap observation at a neighboring
time. Without a verified re-entry signal in TrackFile, all observations from the first
swap onward are suppressed; it never selects another subject.

Refs are canonical session-scoped paths. Proxy is exactly `sessions/{id}/proxy.mp4`;
track refs may also be canonical immutable run-artifact keys under the same session; their bytes still require full TrackFile validation. Session/annotation/segment IDs accept
1–128 ASCII letters, digits, `_` and `-`; unsafe opaque IDs fail before tools/uploads.
Dot components, traversal, encoded paths, controls, query/fragment characters and
foreign sessions are rejected. Local filenames never interpolate annotation IDs.

## Artifacts and cache semantics

Full video: `sessions/{id}/renders/{kind}/full.mp4`.
JPEG: `sessions/{id}/stills/{annotationId}.jpg`.
Segments: `sessions/{id}/renders/{kind}/{segmentId}-{hash}.mp4`.

SPEC §12 now documents the immutable segment filename with its hash: retaining only a mutable range-ID key lets an older `(id,hash)` reference silently retrieve bytes overwritten by a later edit. The explicit key avoids that alias while keeping IDs stable.
Previous refs must use this exact layout. Reuse requires matching id/hash plus a real
download, H.264 format/dimensions/pixel format/fps/timebase/frame count/duration checks,
and validated CFR timestamps. Corrupt, missing or mismatched cache media is rebuilt.
This validates media structure, not cryptographic correspondence of arbitrary uploaded
pixels to annotations: storage must preserve immutable objects.

Frozen-contract limitation: neither proxy bytes nor track bytes have a content digest
in RenderInput. L5 must invalidate previousSegments whenever bytes behind proxyKey or
trackFileRef change. Even hash-addressed render keys must be invalidated/removed then,
since those input bytes are absent from the hash. Full video and JPEG keys remain
mutable per SPEC; parent owns snapshot publication/versioning and cache headers.

## Stills and geometry

The frozen RenderInput was amended in this PR alongside SPEC §7.8: every annotation now requires keyframeMs, copied from its remark's completed MomentOutput. The DAG carries that exact value and includes it in the segment hash. The renderer uses that time, requires it inside the half-open mark window with a safe subject observation, and fails rather than choosing a different frame. A sole fps=0 observation supports still mode; ambiguous multi-frame fps=0 tracks remain rejected.

Geometry fixture v2 freezes numeric anchors and arrowheads for C16. Highlight fills
are alpha-composited against original pixels. All four mark types distinguish dashed
AI from solid coach; arrows point toward the target from every side; top labels have
valid clamped bounds. Roboto is bundled through the pinned `font-roboto` dependency.
Coach text is passed verbatim. If its glyphs are unsupported, rendering fails instead
of emitting replacement boxes; supply a compatible `font_path` for scripts outside
Roboto's coverage. Full multilingual font coverage/shaping in the deployment image is
UNTESTED and must be configured before claiming support for those scripts.

## Validation

- `cd runner && uv run pytest tests/test_render*.py -q`: **97 passed**.
- `pnpm check`: **PASS**, completed through contract generation and Convex bindings:
  JS **300 passed** (21 files), runner **377 passed**, orchestrator **33 passed**;
  lint, TypeScript, both strict mypy checks, 34-contract drift, schema lint and offline
  Convex checks passed.
- `scripts/secret-scan.sh`: **PASS**, history and task source; no leaks.
- `git diff --check`: **PASS**.
- `uv tool run --from pre-commit==4.7.0 pre-commit run --all-files`: **PASS**;
  the actual commit hook also runs without bypass.

All media/tracks in these tests are synthetic, generated locally; no paid/vendor
calls or real clips.
Live/R2 integration, full app E2E (no `pnpm e2e` script yet), final approval snapshot,
T1.26 wiring and production host integration remain UNTESTED / out of lane scope.

Two intermediate full-check reruns failed in untouched parent-owned JS tests:
`worker-sign.test.ts` returned 503 under its 15 ms test deadline, and
`consent.test.ts` had a 1 ms timestamp-boundary assertion failure. Both had passed
in earlier full checks. They are recorded for parent follow-up; no auth/web/Convex
files were changed to hide or loosen them.

## Parent integration review

The parent fixed the measured-font/drawn-font mismatch for shrinking labels,
regenerated TS/Pydantic contracts for keyframeMs, and added selected-frame and
invalid-window regressions. A new actual DAG integration test runs real transcode,
checker and ffmpeg renderer with guarded fake model stages and the typed worker
client (injected transport); it reaches waiting_for_coach with an audio/video MP4
and two still JPEGs. This is not a browser upload-to-student E2E or live Convex run.

Reported test flakes were corrected at their source: successful mocked signing
requests get a normal scheduling budget while timeout tests retain their explicit
short deadline, and consent timestamp assertions use Convex transaction-clock
bounds rather than the host wall clock. Production semantics are unchanged.

Final parent validation: `pnpm check` passed with **317 JS, 383 runner and 33
orchestrator tests**, lint and strict typechecks, 34-contract drift checks, model
schema limits and offline Convex bindings. Live vendor behavior remains UNTESTED.
