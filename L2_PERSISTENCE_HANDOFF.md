# L2 core persistence handoff — T1.10 PARTIAL

Branch `lane/l2-pipeline-persistence`, based on the accepted HTTP lifecycle head `b3d123d88826016cf4945be50193f871dc800d3a`, merged with consent-contract `47650ed8f120e74998f9038a2b734b19c6270775`. Depends on PRs #1, #5, #8. No subagents, paid API, runtime credentials or real-person media were used. Bala reviews/merges. Existing lifecycle/token behavior is preserved.

## Frozen wire

All nine endpoints are registered POSTs with job-token Bearer authentication:

| Endpoint suffix under `/worker/persist/` | Output contract | Additional required metadata |
|---|---|---|
| `transcode` | `TranscodeOutput` | none |
| `turns` | `TranscribeOutput` | none |
| `plan` | `PlanOutput` (code-postprocessed) | none |
| `moment` | `MomentOutput` | none |
| `target` | `SubjectAnchorOutput` when run.remarkId is absent; otherwise `SubjectOutput` | none |
| `track` | `TrackOutput` | `cacheKey`: 64 lowercase hex, runner's §7.5 computation |
| `marks` | `PlaceOutput` | `provenance`: `Provenance` |
| `verdicts` | `CheckOutput` | none |
| `render` | frozen `RenderOutput` | none |

The exact envelope is `{stageRunId,output,...additionalMetadata}`. Unknown/missing/null-required fields reject. `stageRunId` is an actual Convex ID; callers supply no coach/session/job identity. All outputs use the existing source JSON Schemas, unchanged. Success is `{ok:true}`; marks returns `{ok:true,annotationIds:[{markId,annotationId}]}`, sorted lexicographically by markId. Those are actual owned annotation row IDs for RenderInput. Transcode persists only supplied measured duration; this is the §7.0/§9/§10.4 metadata clarification, not selection-frame extraction. The pipeline stays tap-gated.

Persistence envelopes enforce a streamed 1,048,576-byte total limit regardless of Content-Length; lifecycle retains 32,768 bytes. Invalid UTF-8/JSON and oversized bodies return fixed `INVALID_REQUEST`. Verbatim-copy failures return fixed `VERBATIM_MISMATCH`; other worker transaction/contract failures return fixed `WORKER_REJECTED`; unauthenticated requests return `UNAUTHORIZED`. No raw errors, transcript text, notes, tokens, signed URLs or outputs are logged/returned as error details.

`GET /worker/job` adds exactly `session.studentLabel` and `session.subjectRole`. The label is fetched from the actual owned student row; missing, empty or foreign student denies. Contact fields and student documents are never projected. Existing source upload fields, nullable fields, completed artifact filtering and subject-retrack eligibility remain unchanged; consult `L2_HTTP_HANDOFF.md` for that lifecycle wire. Its statement that persistence is absent describes the earlier slice and is superseded here.

## Validation and transactions

The generator emits `convex/persistenceValidators.ts` for closed Convex shapes and `packages/contracts/gen/persistenceValidation.ts` for full constraints, derived from dereferenced source JSON Schemas. Pure schema evaluation enforces numeric bounds, finite/safe-integer numbers, array counts/uniqueness, code-point string lengths, patterns, constants and record keys. Unsupported new validation keywords fail generation; no runtime eval or AJV compilation is used. `contracts:check` regenerates and compares both outputs and the source manifest. The existing generator helper now correctly emits structural records for patternProperties. No runtime dependency or source stage schema amendment was needed.

Each persistence mutation re-verifies the token, latest running job, live lease, session/coach ownership, actual run/stage/remark and pinned worker/provider/model/candidate. Authorization and every projection write occur in the same transaction. Upstream provenance is separately resolved from actual rows. Nothing trusts caller-supplied ownership.

The internal `stageRuns` receipt fields are optional and excluded from public StageRun JSON:

- `persistedOutputHash`: SHA-256 of UTF-8 recursively key-sorted canonical JSON `{output,...additionalMetadata}`. Arrays preserve order; all numbers were validated first. No raw output/text is stored in this field.
- `persistedAnnotationIds`: marks' stable response mapping only, so exact retries still return the original IDs even after later derived AI changes/deletions. A retry does not recreate a deleted row.
- `persistedTrackBinding`: `{trackId,fileRef}` only, checked against the actual owned track row during placement so a different run/ref cannot be substituted.

The first persist requires a running run, writes receipt plus projections atomically, and the runner then finishes its stage. Failed validation rolls back all writes and the receipt. An identical replay while running or done returns success without changing projections, timestamps, approvals or corrections. A changed replay rejects. A stopped/expired/superseded job always denies, including exact persist replays. Only `/worker/done` retains the earlier terminal-job exception. A run cannot first persist after finishing. A superseded run cannot first persist after a newer same-stage/remark run starts.

New attempts can replace unedited AI-derived data. Existing transcript original text/speaker/times and remark turn assignments cannot change; `correctedText` stays untouched. Plan checks every turn belongs to this session and at most one remark, orders turns chronologically, re-copies joined original text with exactly one space, byte-compares, validates first-turn atMs and exact fanout/draft refs. Existing remarks retain coach-controlled mode/share/status. Other-person/general remarks are note-only, no fanout, with pinned `otherPersonRemarksInShare`. Lesson focus/practice are unapproved AI drafts; coach-origin/approved/edited entries and existing notes survive later plans. No `aboutHint` DB field is invented.

Moments are bounded by measured duration and pinned maxMomentMs; keyframe must be inside. Anchor requires the current coach tap and matching frame, valid box and canonical crop. Subject outputs must match owned remark/keyframe and the selected role; boxes/points are validated. No targets table exists; full targets remain stage output artifacts. Track rows use the selected role, canonical file/mask refs, supplied cache computation and schema-constrained coverage/usage. The server does not fetch TrackFile: subjectOnly, frame-level coverage and swap detection remain the runner's responsibility.

Placement re-copies spans from this remark's immutable original turns, calls `sliceCoachSpan`, rejects surrogate splits/non-word boundaries and spans/text over 60 UTF-16 code units (or tighter pinned cap), and byte-compares. Neutral roles are Batter/Bowler/Player; `Remark {n}` is **one-based over all session remarks sorted by atMs ascending, then remarkId ascending using code-unit lexical comparison**. Runner PlaceInput.remarkNumber must follow that ordering. Mark IDs are unique, time ranges sit inside the owned moment, types use the pinned allowlist, and free geometry is rejected. New marks always have `placedBy:ai,status:needs_you`, no approvedAt, and original aiPlacement. Replacements never alter coach-origin/approved/deleted/placement-edited items; their bound moments/tracks are protected too. Existing explanatory why text is preserved on same-mark replacement.

Provenance must contain exactly four stage keys `moment,subject,track,place` in both stageRunIds and workers. Each points to a real owned same-remark run under the pinned configuration, with a persistence receipt. Upstream runs must be done; place must be this running run. Only a subject_retrack may reuse a prior same-session/same-config completed moment. Workers equal actual worker IDs. modelVersions is keyed by stage and contains exactly actual non-null model versions. placedBy is ai; candidate equals the actual place run candidate or null. Check adds its own actual run/worker/model without trusting a supplied check identity.

Verdicts cover exactly known AI mark IDs for the remark, without missing/duplicate/foreign IDs; pass iff reason=ok. All marks failing for no_player/subject_swap/low_coverage gives player_missing; other combinations give ok. Marks stay unapproved; protected coach edits stay unchanged. Render records only supplied validated preview output, actual measured duration, canonical refs and owned still annotation IDs, with one immutable ready row per job/kind. It does not fabricate media or claim to inspect opaque rendered files.

## Remaining work

T1.10 remains **PARTIAL**. `/worker/cost`, `/worker/persist/nextFocus`, and agent trace persistence are deliberately unregistered. No generic arbitrary-write route exists. Final render is fail-closed even for a final RenderOutput: finalize must first bind a frozen approved snapshot/input so the server can verify that an opaque final video cannot expose unapproved items. Frozen RenderOutput is unchanged. No UI/storage/runner/orchestrator work, dependency/lock/config modifications, paid services or full M1 E2E is claimed. Live Convex deployment/transaction/crypto behavior remains **UNTESTED**; evidence below uses real convex-test HTTP routing and database transactions.

## Verification

Final results are appended after required checks and hooks finish. Logs are disposable `.orca-scratch/` files and are never staged.

- `pnpm check`: **PASS** — ESLint; both strict TypeScript projects; **258 JS tests in 14 files**, including **71 new persistence/verbatim tests** and the unchanged **64 HTTP lifecycle + 11 token tests**; Ruff; strict mypy **57 runner + 2 orchestrator source files**; **124 runner + 1 orchestrator tests**; **34 contracts verified**, **6 model-output schemas** within structural limits, offline Convex bindings verified.
- `pnpm contracts:gen` and `pnpm convex:codegen`: **PASS**. Source stage schemas and public StageRun/RenderOutput stay unchanged. Manifest includes persistence/schema/HTTP/worker/generator validation-source digests.
- `scripts/secret-scan.sh`: **PASS**, real gitleaks scans of history and task source. `git diff --check`: **PASS**.
- `uv tool run --from pre-commit==4.7.0 pre-commit run --all-files`: **PASS**, real gitleaks hook; actual commit hook also required. No exclusions, bypasses or secrets were added.
- `pnpm e2e`: not available (T1.31 not implemented). No live Convex/vendor or full M1 E2E success claimed.

Parent review: keyframes now use exclusive moment/clip endpoints, matching the runner's half-open windows. Track collision checks use the new `by_trackId` index and replacements use `by_sessionId`, avoiding a cross-session full-table scan. Regression tests cover endpoint rejection and cross-remark track identity collision with transactional rollback. `pnpm check` PASS after review: **261 JS, 124 runner, 1 orchestrator**; focused persistence/verbatim **74 tests**; contract/binding checks, secret scan, diff check and actual commit hook pass.
