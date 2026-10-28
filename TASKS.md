# NetSense tasks

Ordered build tasks for the coding agent. Read AGENTS.md and SPEC.md first. Lanes and parallel work are in WORKPLAN.md.

**v1.1 (Wed 28 Oct 2026, 3:05 PM SGT):** one selected person is tracked (SPEC §0, DECISIONS F1). Start with **"Ready to test now"** below: it needs no paid keys.

Tags: **[KEYS]** needs real API keys or accounts (SETUP.md). **[HUMAN]** needs Bala: real clips of adults who agreed to be filmed, a decision, or a manual check. **[UNTESTED]** depends on a vendor capability not yet proven by M0. Tasks without tags run with `provider=fake`, `SANDBOX_DRIVER=local`, `STORAGE_DRIVER=local`.

Rule for every task: the M1 path (upload → status → review → share → student) must still work after the task merges (`pnpm check` green, E2E green once T1.31 exists).

Milestones: **M0** feasibility spike (task 0) · **M1** minimum version, built as a thin end-to-end path first (M1a skeleton with fake workers, M1b real stages, M1c review and share, M1d ship) · **Extras** in reverse cut order.

Effort (PROPOSAL, all unmeasured): minimum version ~11.0 dev-days, ~11.25–11.5 with Modal, ~8.5–8.75 with every cut, against ~8 days available (27 Oct–4 Nov). Cuts 1–5 are already applied below; cuts 6–9 are decided at the Thu 29 Oct and Sat 31 Oct checkpoints; 10–12 are last resorts. Each cut is a flag (SPEC §17). v1.1 removes work (no batter/bowler pairing, no bowler picker) and adds work (07a subject picker, subject anchor + re-identification, swap guard); net effect on effort is roughly neutral and **unmeasured**.

---

## M0 · Feasibility spike (task 0) · due Wed 28 Oct 2026, 11:59 PM SGT

### T0.1 [HUMAN] [KEYS] Accounts and keys
- Depends on: none
- Files: none in repo (local `.env`, never committed)
- Do: SETUP.md steps 1 (Meta), 4 (Modal), and 5 (R2) if S1 = R2.
- Accept: `curl` to `/v1/models` lists `muse-spark-1.3`, `muse-voice-transcribe-1.0`, `sam-3.1`; `modal token` works; credits status recorded in SETUP.md notes.
- Test: SETUP.md verify commands.

### T0.2 [HUMAN] Spike clips
- Depends on: none
- Files: none in repo (clips stay in `spike/clips/`, git-ignored)
- Do: 2–3 real net clips, ≥ 5 deliveries (or segments) each, **several people in frame**, coach talking, adults who agreed to be filmed; record agreement off-app (D2). One iPhone (HEVC MOV) and one H.264 MP4 if possible. For each clip, Bala picks the subject once: fill `spike/clips/deliveries.csv` with `clip, delivery, startMs, endMs, subjectFrameMs, subjectX, subjectY` (x, y as 0–1 fractions of the frame; `spike/pick_subject.py` shows a frame and records the click).
- Accept: clips present locally; `deliveries.csv` filled; agreement note recorded by Bala.
- Test: n/a.

### T0.3 [KEYS] [UNTESTED] Spike harness: transcribe + SAM with a selected subject
- Depends on: T0.1, T0.2
- Files: `spike/README.md`, `spike/transcode.sh`, `spike/transcribe.py`, `spike/pick_subject.py`, `spike/sam_image.py`, `spike/sam_window.py`, `spike/draw_boxes.py`, `spike/report.py`, `spike/pyproject.toml`
- Do: transcode to proxy + WAV (SPEC §7.0); Voice Transcribe each clip; anchor: SAM 3.1 image request with a **point prompt** at the subject tap → subject box + reference crop; for each delivery cut a ~10 s window, upload with Files API, run SAM 3.1 seeded with the subject's box on the window's first frame (one object only); also run concept "person" on the window's key frame to count people; parse with `meta-sam-parser`; draw the subject's box (and any other ids, in grey) into a review MP4; log latency, frames billed, output bytes, people in frame, swap flags from the IoU guard to `spike/out/results.csv` (git-ignored). Optional: one whole-video run seeded on the tap frame, for cost and swap comparison.
- Accept: results for S-1, S-2, S-3, S-5, S-6, S-7 and the transcription check per delivery/segment; for S-3, Bala marks each review MP4 "followed / swapped / lost" by eye.
- Test: `uv run python spike/report.py` prints the S-table with pass/fail counts.

### T0.4 [KEYS] [UNTESTED] Modal sandbox smoke
- Depends on: T0.1
- Files: `spike/modal_smoke.py`, `infra/modal/image.py` (first draft)
- Do: build a named image with ffmpeg; create a sandbox with name, tags, timeout, idle_timeout; run `ffmpeg -version` and a 10 s transcode via signed URLs; terminate in `finally`; list sandboxes by tag; try creating a second sandbox with the same name while the first runs; measure cold start and cost per minute.
- Accept: sandbox created, ran, terminated; list-by-tag shows none open afterwards; duplicate name refused; numbers in `docs/spike/sam-spike.md`.
- Test: `uv run python spike/modal_smoke.py` exits 0 and prints "released".

### T0.5 [KEYS] [UNTESTED] Subject re-identification probe (S-4)
- Depends on: T0.3
- Files: `spike/subject_probe.py`
- Do: per delivery key frame (not the tap frame): SAM image "person" boxes → numbered overlay → Muse Spark gets the reference crop + numbered frame and returns the box number of the same person or 0 (SPEC §8.3); compare with the position prior.
- Accept: hit rate over ≥ 10 deliveries/segments; count of confident wrong picks (must be 0 for Go).
- Test: results rows in `spike/out/results.csv`.

### T0.6 [HUMAN] Spike verdict
- Depends on: T0.3, T0.4, T0.5
- Files: `docs/spike/sam-spike.md`
- Do: fill the S-1…S-7 table (subject criteria: selected person found and followed with no swap in ≥ 4/5), transcription verdict, Modal verdict; choose **Go** (tracked), **Partial** (S-1 and S-2 only → Still frames only), or **No-go**; update `config/pipeline_config.v1.json` `renderModeDefault`, timeouts and caps; tell Bala by Thu 29 Oct morning if No-go.
- Accept: verdict recorded with numbers; RUNBOOK log row added.
- Test: n/a.

---

## Ready to test now (no paid keys) · start here

This chunk gets the repo to "ready to test" on a laptop with no Meta, Modal or R2 keys. Order:

| # | Task | What it gives you | Needs |
|---|---|---|---|
| 1 | T1.01 scaffold | `pnpm check`, `uv run pytest` | nothing |
| 2 | T1.02 contracts | all schemas incl. `Subject`, `SubjectRole`, `Subject*`, generated TS + Pydantic | nothing |
| 3 | T1.03 Convex schema + core functions | `sessions.subject`, `subjectStatus`, job gating | nothing for unit tests (`convex-test`); a free Convex dev deployment for the app |
| 4 | T1.08 stage interface + registry | `fake` provider selectable | nothing |
| 5 | T1.10 Convex worker/service API | runner can talk to Convex | nothing for unit tests |
| 6 | T1.09 runner DAG with fake workers | full DAG incl. subject anchor, fake SAM stream with 3 people | nothing |
| 7 | T1.11 **local driver part** | sandbox lifecycle (acquire, heartbeat, terminate in `finally`, sweeper) with `SANDBOX_DRIVER=local` | nothing (Modal driver half waits for T0.4) |
| 8 | T1.12 transcode | real ffmpeg on synthetic clips | ffmpeg |
| 9 | T1.35 subject selection UI (07a) + `sessions.setSubject` | coach taps one person | free Clerk dev keys for the page; component tests need nothing |
| 10 | T1.13 screen 12 | live status | free Convex + Clerk dev keys for E2E |
| 11 | T1.20 + T1.21 with synthetic tracks | check rules incl. `subject_swap`; preview render of a single-subject track | nothing (they consume fake stage 6 output until T1.19 lands) |
| — | **IC2** | synthetic clip → tap subject → job → local sandbox → fake stages → render → screen 12 done → sandbox released | Convex + Clerk free dev accounts (SETUP steps 2–3) |

Honest notes: no paid keys are needed for any row. Convex and Clerk free dev accounts are needed only for running the app and E2E (unit tests use `convex-test`). Running Convex fully local (`npx convex dev --local` style) is **UNTESTED** here; if it works it removes even that need.

---

## M1a · Skeleton: contracts, data, auth, upload, runner with fake workers

### T1.01 Repo scaffold and tooling
- Depends on: none
- Files: `package.json`, `pnpm-workspace.yaml`, `apps/web/*` (Next.js App Router, TS strict, Tailwind), `runner/pyproject.toml`, `services/orchestrator/pyproject.toml`, `.gitignore`, `.editorconfig`, `.github/workflows/ci.yml`, `.pre-commit-config.yaml` (gitleaks), `scripts/check-env.ts`
- Accept: `pnpm install && pnpm check` (lint, typecheck, unit) passes; `uv run pytest` passes in both Python packages; gitleaks pre-commit installed; `.gitignore` covers `.env*` (except `.env.example`), `spike/clips`, `spike/out`, `local-fixtures/`, `demo-bundles/`, `*.mp4`, `*.mov`, `*.wav`.
- Test: CI workflow runs locally via `pnpm check`.

### T1.02 Contracts package
- Depends on: T1.01
- Files: `packages/contracts/schemas/*.json` (Common incl. `Subject`/`SubjectRole`, ErrorCode, Transcode*, Transcribe*, Plan*, Moment*, SubjectAnchor*, Subject*, Track*, Place*, Check*, Render*, PipelineConfig, StageRun, Provenance), `packages/contracts/gen/` (TS), `runner/netsense_runner/contracts/` (Pydantic, generated), `scripts/gen-contracts.sh`, `fixtures/synthetic/contracts/*.json`
- Accept: every schema in SPEC §7 and §8 exists; agent model-output schemas pass a Muse Spark limits linter (no recursion, depth ≤ 10, no allOf/oneOf, root not anyOf, `additionalProperties:false`, all keys required); `pnpm contracts:check` fails on drift.
- Test: `pnpm test:contracts`; `uv run pytest runner/tests/test_contracts.py`.

### T1.03 Convex schema, config seed, core functions
- Depends on: T1.02
- Files: `convex/schema.ts`, `convex/config.ts`, `convex/sessions.ts`, `convex/students.ts`, `convex/jobs.ts`, `convex/stageRuns.ts`, `convex/lib/auth.ts`, `config/pipeline_config.v1.json`, `config/prices.json`
- Accept: schema matches SPEC §9 (v1.1: `studentId`, `subjectRole`, `subject`, `subjectStatus`; job kind `subject_retrack`); `jobs.enqueueWhenReady` enqueues the pipeline exactly once when both upload complete and subject set (either order); `config.seed` inserts v1 once; `jobs.claim` is atomic (two concurrent claims never both win); `stageRuns.finish` rolls up `coachStage/progress`.
- Test: `convex-test` suites `convex/tests/jobs.test.ts`, `convex/tests/subject-gating.test.ts`.

### T1.04 [KEYS] Clerk auth + screen 01
- Depends on: T1.03
- Files: `apps/web/middleware.ts`, `apps/web/app/sign-in/[[...sign-in]]/page.tsx`, `apps/web/app/providers.tsx` (ConvexProviderWithClerk), `convex/auth.config.ts`, `convex/lib/auth.ts`
- Accept: signed-out users are redirected from `/sessions`; first sign-in creates a `coaches` row; a second coach cannot read the first coach's sessions.
- Test: convex-test ownership tests; Playwright with Clerk testing tokens (dev instance keys).

### T1.05 Storage interface + local and R2 adapters
- Depends on: T1.01
- Files: `apps/web/lib/storage/{types,local,r2,index}.ts`, `apps/web/app/api/media/local/[...key]/route.ts`, `apps/web/app/api/media/sign/route.ts`, `apps/web/app/api/worker/sign/route.ts`, `apps/web/lib/tokens.ts`
- Accept: interface in SPEC §12; local adapter supports multipart, Range GET, HMAC-signed URLs with expiry; R2 adapter compiles and passes against R2 when keys exist [KEYS]; worker sign rejects keys outside its session prefix and expired tokens.
- Test: vitest `storage.local.test.ts`, `worker-sign.test.ts`; `storage.r2.live.test.ts` skipped without R2 env.

### T1.06 Upload flow + screens 06, 07, 08
- Depends on: T1.04, T1.05
- Files: `apps/web/app/sessions/[id]/record/page.tsx`, `apps/web/app/sessions/[id]/upload/page.tsx`, `apps/web/lib/upload/{multipart,sha256,resume}.ts`, `apps/web/app/api/uploads/**/route.ts`, `convex/uploads.ts`
- Accept: SPEC §4.1 and §10.2: progress counts confirmed parts only; resume after reload by matching SHA-256; 3 failed attempts mark "Upload failed"; `/complete` checks size and enqueues a `pipeline` job only once the subject is set (else routes to 07a); Cancel asks first.
- Test: vitest for resume logic; Playwright uploads a synthetic clip, kills network mid-way, resumes.

### T1.07 Sessions screens 02, 03, 04
- Depends on: T1.04
- Files: `apps/web/app/sessions/page.tsx`, `apps/web/app/sessions/new/page.tsx`, `apps/web/components/session-row.tsx`, `apps/web/components/status-badge.tsx`
- Accept: empty state copy per SPEC §4.1; list shows live status, filters, routing by state; new session requires a student and a role (Batting / Bowling / Other), no bowler picker; + Add a student stores a label only.
- Test: component tests; Playwright create-session.

### T1.08 Stage interface, adapters, provider registry
- Depends on: T1.02
- Files: `runner/netsense_runner/{stage,context,budget,registry}.py`, `runner/netsense_runner/adapters/{agent,model_api,tool,rules}.py`, `runner/netsense_runner/providers/{meta,fake,gemini_stub}.py`
- Accept: SPEC §6.2–6.3; `fake` provider refuses to load when `NETSENSE_ENV=prod`; `gemini_stub` raises `NotConfigured` unless G1 enables it; agent adapter sends `response_format` json_schema strict and images as data URLs.
- Test: `runner/tests/test_adapters.py` with recorded-shape HTTP mocks.

### T1.09 Runner DAG
- Depends on: T1.08, T1.10
- Files: `runner/netsense_runner/{__main__,dag,fanout,idempotency,heartbeat,worker_api}.py`, `runner/netsense_runner/stages/fake_*.py`
- Accept: pinned config; transcode → 1 → 2 → subject anchor → per-remark 3–7 (cap `FANOUT_CONCURRENCY`) → 8; `subject_retrack` reuses 1–3 outputs; fake SAM stream includes 3 people and the runner keeps only the subject; validates contracts; writes stageRuns; retries/timeouts per config; idempotent resume; budget stop; heartbeat thread; `finally` posts `/worker/done` and deletes Files API uploads. With fake workers it drives a session to `waiting_for_coach`.
- Test: `runner/tests/test_dag.py` (cap honoured, failure isolation, resume skip, budget).

### T1.10 Convex worker and service HTTP API
- Depends on: T1.03
- Files: `convex/http.ts`, `convex/worker.ts`, `convex/svc.ts`, `convex/pipeline.ts` (persist functions), `convex/lib/jobToken.ts`
- Accept: SPEC §10.3–10.4; job token HMAC + expiry + running-job check; persist functions re-copy coach words and reject `VERBATIM_MISMATCH`.
- Test: convex-test `worker.test.ts`, `verbatim.test.ts`.

### T1.11 [KEYS for modal driver] [UNTESTED] Orchestrator, sandbox lifecycle, sweeper (local driver half is in "Ready to test now")
- Depends on: T1.09, T1.10, T0.4
- Files: `services/orchestrator/netsense_orch/{main,lifecycle,drivers/modal_driver,drivers/local_driver,sweeper,convex_svc}.py`, `infra/modal/image.py`, `infra/vm/netsense-orchestrator.service`
- Accept: SPEC §11 end to end: claim, acquire (name, tags, timeout, idle_timeout), watch heartbeat, **terminate in finally on every path**, `sandboxes` row with `terminatedBy`, retry with resume, sweeper kills orphans, daily spend check before claim. Local driver passes the same tests.
- Test: `services/orchestrator/tests/test_lifecycle.py` with a fake driver covering success, runner crash, stale heartbeat, timeout, orchestrator restart; live check [KEYS]: one fake-provider job on Modal, then `pnpm runs:sandboxes --open` is empty.

### T1.12 Transcode pre-stage
- Depends on: T1.09
- Files: `runner/netsense_runner/stages/s0_transcode.py`, `runner/netsense_runner/media/{ffmpeg,keyframes}.py`
- Accept: SPEC §7.0: size + SHA-256 verify, 720p faststart proxy, WAV chunks ≤ 9.5 min, `audio.m4a`, 2 fps key frames and index; HEVC MOV and WebM inputs handled.
- Test: pytest on synthetic clips generated by `scripts/make-synthetic-clip.sh` (MP4, MOV/HEVC if ffmpeg build supports it, WebM).

### T1.13 Screen 12 processing status (skeleton checkpoint)
- Depends on: T1.06, T1.10
- Files: `apps/web/app/sessions/[id]/status/page.tsx`, `apps/web/components/coach-stages.tsx`
- Accept: six coach rows from `pipeline_config.coachStages`, live via Convex subscription, progress label, no model names, "Only you can see this draft".
- Test: component test with a mocked job; Playwright on the fake pipeline reaches "Prepare preview" done.

### T1.35 Subject selection: screen 07a + `sessions.setSubject` + Change who to follow
- Depends on: T1.03 (UI part also T1.06)
- Files: `apps/web/app/sessions/[id]/subject/page.tsx`, `apps/web/components/subject-picker/{frame-scrubber,tap-target}.tsx`, `apps/web/lib/video/grab-frame.ts`, `convex/sessions.ts` (setSubject), `convex/jobs.ts` (enqueueWhenReady, subject_retrack)
- Accept: SPEC §4 screen 07a: frame decoded locally from the picked file (no upload needed), scrub, tap → normalised point stored with `frameMs` and role; Retake; Confirm; "Pick after upload" fallback using server key frames when the browser cannot decode; pipeline enqueues only when upload complete + subject set; "Change who to follow" on 19 enqueues `subject_retrack`; copy says other people are ignored; no model names. **Design gap:** no wireframe for 07a; build with existing components and flag screenshots to Bala.
- Test: vitest for point normalisation (portrait, landscape, letterboxed video); convex-test for gating in both orders; Playwright: synthetic clip → tap → job starts.

**Checkpoint IC2 (walking skeleton):** synthetic upload → tap subject (07a) → job → sandbox (local driver; Modal if T0.4 passed) → fake stages → screen 12 complete → sandbox released.

---

## M1b · Real stages (each swaps a fake worker; M1 path stays green)

### T1.14 [KEYS] [UNTESTED] Stage 1 transcribe
- Depends on: T1.12
- Files: `runner/netsense_runner/stages/s1_transcribe.py`
- Accept: SPEC §7.1: multipart request, chunk offset merge, keywords, error mapping (400/413 → `AUDIO_DECODE`, 429 backoff, 500 retry once), `NO_SPEECH`.
- Test: pytest with HTTP mocks (all error codes); live [KEYS]: one spike clip transcribes.

### T1.15 [KEYS] Stage 2 plan (orchestrator agent)
- Depends on: T1.14
- Files: `runner/netsense_runner/stages/s2_plan.py`, `prompts/_preamble.md`, `prompts/plan.md`
- Accept: SPEC §7.2, §8.1: structured output, coach speaker filter, turn ids valid and unique, `coachWords` copied in code, ≤ 2 focus drafts, drafts `ai_draft`/`approved:false`, `aboutSubject` routing (`no`/`general` → note-only, left out of share by default).
- Test: pytest with fake provider + adversarial outputs (unknown turn id, duplicate turn, text in place of ids).

### T1.16 [KEYS] Stage 3 moment
- Depends on: T1.15
- Files: `runner/netsense_runner/stages/s3_moment.py`, `prompts/moment.md`
- Accept: SPEC §7.3, §8.2: frame-index enum built per call, idx → ms mapping, window cap, `why` stored.
- Test: pytest mapping and clamping; live sample on a spike clip.

### T1.17 [KEYS] [UNTESTED] Stage 4 subject resolver (anchor + re-identification)
- Depends on: T1.16, T1.35
- Files: `runner/netsense_runner/stages/s4_subject.py`, `runner/netsense_runner/stages/s4a_subject_anchor.py`, `runner/netsense_runner/rules/position_prior.py`, `runner/netsense_runner/media/{numbered_boxes,crop}.py`, `prompts/subject.md`
- Accept: SPEC §7.4, §8.3: anchor from the tap (point prompt, mask containing the point, reference crop); `SUBJECT_NEEDED` if nothing at the tap; per window: anchor reuse within `anchorReuseMs`, "person" candidates ≤ 6, numbered overlay, Spark re-id with reference crop, position prior tie-break, `pointPrompt` path for "Tap them", `boxNumber 0` → `SUBJECT_NOT_FOUND` → `needs_coach`. Never tracks or marks anyone else.
- Test: pytest anchor selection and position prior tables; synthetic SAM responses with 3 people; live [KEYS] on a spike clip.

### T1.18 [KEYS] [UNTESTED] Stage 5 track (SAM 3.1)
- Depends on: T1.17
- Files: `runner/netsense_runner/stages/s5_track.py`, `runner/netsense_runner/sam/{client,stream,associate,swap_guard}.py`
- Accept: SPEC §7.5: window cut, Files API upload with expiry and delete in finally, streaming request seeded with the subject only, parser keeps only the subject's id, sparse/unsorted frames, IoU re-association, **swap guard** (`swapSuspected`, `swaps[]`), coverage, cache, frame cap, still mode.
- Test: pytest on synthetic stream text with a planted swap and a planted re-association; live [KEYS] one delivery window.

### T1.19 [KEYS] Stage 6 place
- Depends on: T1.18
- Files: `runner/netsense_runner/stages/s6_place.py`, `prompts/place.md`
- Accept: SPEC §7.6: ≤ 3 marks, anchors only, span copy on word boundaries ≤ 60 chars, neutral labels from `subjectRole` (Batter/Bowler/Player), `allowedMarkTypes` from flag.
- Test: pytest span trimming and verbatim.

### T1.20 Stage 7 rules checker + session routing
- Depends on: T1.19
- Files: `runner/netsense_runner/stages/s7_check.py`, `runner/netsense_runner/rules/{checker,stills_routing}.py`
- Accept: SPEC §7.7 reasons incl. `subject_swap`; `player_missing` remark status with `SUBJECT_NOT_FOUND`/`SUBJECT_SWAP`; session-level `SEG_NO_TRACK` → screen 15. Buildable before T1.19 against fake stage-6 output.
- Test: pytest table tests.

### T1.21 Stage 8 render (preview) + stills
- Depends on: T1.20
- Files: `runner/netsense_runner/stages/s8_render.py`, `runner/netsense_runner/media/{overlay_draw,segments,concat}.py`
- Accept: SPEC §7.8: segment merge, Pillow overlays (dashed AI, solid coach), ffmpeg composite, concat, faststart; stills JPEG per annotation; segment hashes for reuse; `RENDER_FAIL` handled.
- Test: pytest renders a synthetic clip with synthetic track; ffprobe checks duration and codec.

### T1.22 Error screens 13, 14, 15, 16 + actions
- Depends on: T1.13, T1.10
- Files: `apps/web/app/sessions/[id]/status/*`, `apps/web/components/errors/*`, `apps/web/components/typed-remark-form.tsx`, `convex/jobs.ts` (requeueStage, retrack), `convex/review.ts` (addTypedRemark, setMode)
- Accept: SPEC §4.2 and §15; every action creates the right job kind; typed remarks have no Hear coach; 16 never blocks other remarks and shows the swap variant; "Tap them" taps the same selected person on that moment's frame.
- Test: Playwright with fake provider configured to fail each stage.

**Checkpoint IC3 (Thu 29 Oct):** stages 1–2 live on a real clip. **IC4 (Fri 30 Oct):** fan-out 3–7 live (selected subject only). **IC5 (Sat 31 Oct, end-to-end):** real clip → tap subject → review on the phone. Decide cuts 6–9.

---

## M1c · Review, share, student

### T1.23 Video player + live overlay + screens 17, 18
- Depends on: T1.21, T1.13
- Files: `apps/web/components/player/{video-player,overlay-canvas,timeline,remark-list,hear-coach}.tsx`, `apps/web/lib/overlay/draw.ts`, `apps/web/app/sessions/[id]/playback/page.tsx`
- Accept: preview MP4 if ready else live overlay drawn with `requestVideoFrameCallback` from annotations + track JSON (same geometry as Pillow); active remark; tap to jump; Hear coach plays `audio.m4a` between turn start and end; Still frames only banner and strip on 18.
- Test: unit test that TS and Python overlay geometry agree on synthetic tracks (shared JSON fixture); Playwright playback.

### T1.24 Review screens 19, 20
- Depends on: T1.23
- Files: `apps/web/app/sessions/[id]/review/**`, `apps/web/components/review/*`, `convex/review.ts`
- Accept: SPEC §4.3: tabs, quote block, AI-placed tag, Why here, Approve/Edit/Move/Delete/Undo one at a time, transcription fix "corrected by coach", move/retime/note-only (no reassign to another person), 16 options when no track, "Change who to follow"; no bulk approve mutation or UI; `FEATURE_REVIEW_MODE=simple` path.
- Test: convex-test (no multi-approve), Playwright review flow.

### T1.25 Screen 21 notes, focus, practice
- Depends on: T1.24
- Files: `apps/web/app/sessions/[id]/review/notes/page.tsx`, `convex/lessons.ts`
- Accept: coach note solid; AI drafts dashed with Why; third focus blocked; practice list hidden when `FEATURE_PRACTICE_PLAN` off (cut 6).
- Test: component + convex-test.

### T1.26 [UNTESTED for Modal] Finalize job: final render + next-session focus
- Depends on: T1.21, T1.24, T1.11
- Files: `runner/netsense_runner/finalize.py`, `prompts/next_focus.md`, `convex/jobs.ts` (requestFinalize), `convex/pipeline.ts` (persistNextFocus)
- Accept: SPEC §4.5, §7.8: fresh sandbox; only changed segments re-render; next-session focus drafted from approved items only; sandbox released.
- Test: pytest segment reuse; orchestrator lifecycle test for `finalize`.

### T1.27 Share screens 22, 23 + link creation
- Depends on: T1.25
- Files: `apps/web/app/sessions/[id]/share/**`, `convex/share.ts`, `apps/web/lib/link/{token,code}.ts`
- Accept: SPEC §4.3, §14: snapshot of approved items only, remarks not about the subject excluded by default, token and code shown once and stored hashed, 30-day expiry, Turn off link, Opened, hackathon consent line on 22, Web Share API.
- Test: convex-test snapshot excludes unapproved/dismissed/deleted; hashes only in DB.

### T1.28 Student screens 24, 25, 26, 27
- Depends on: T1.27, T1.23
- Files: `apps/web/app/l/[token]/**`, `apps/web/app/api/l/[token]/**`, `apps/web/lib/student-session.ts`
- Accept: SPEC §4.4, §14: code check, 5 wrong → 15 min lock, cookie session, signed media from snapshot only, noindex and no names in title, footer line, no download control, stopped page identical for expired and revoked.
- Test: vitest lockout and cookie; Playwright student flow on a second browser context.

---

## M1d · Ship

### T1.29 Observability + cost guards
- Depends on: T1.11, T1.21
- Files: `scripts/{runs-show,runs-sandboxes,cost-today,config-show,config-new,config-activate,jobs-requeue,jobs-retry}.ts`, `convex/costLedger.ts`, `runner/netsense_runner/logging.py`, `services/orchestrator/netsense_orch/logging.py`
- Accept: SPEC §16, §18: JSON logs scrubbed; ledger rows per paid call; daily stop works; CLI prints stage tables; `config:new`/`config:activate` create and switch immutable config versions; `jobs:requeue`/`jobs:retry <jobId> <stage>` re-queue safely; `runs:sandboxes --open --terminate` asks before terminating.
- Test: pytest log scrubber (no secrets, no transcript text); convex-test ledger totals.

### T1.30 [KEYS] [HUMAN] Deploy to the instabox VM
- Depends on: T1.11, T1.28
- Files: `infra/vm/{netsense-web.service,netsense-orchestrator.service,install.sh,README.md}`
- Accept: SETUP.md step 6 done; web + orchestrator run as systemd units with `/data/netsense/.env` (mode 600); Convex prod deployed; `/api/health` ok over the public URL; Clerk allowed origins set.
- Test: RUNBOOK "Run one video end to end" on the VM.

### T1.31 E2E suite + live smoke
- Depends on: T1.28
- Files: `tests/e2e/*.spec.ts`, `playwright.config.ts`, `scripts/smoke-live.ts`, `scripts/make-synthetic-clip.sh`
- Accept: full M1 path green with fake provider; `pnpm smoke:live` [KEYS] [HUMAN clip] passes on one real clip and asserts sandbox released and cost under cap.
- Test: itself; runs in CI (fake only).

### T1.32 Demo fallback (labelled)
- Depends on: T1.28
- Files: `scripts/demo-export.ts`, `scripts/demo-import.ts`, `apps/web/components/fallback-badge.tsx`
- Accept: SPEC §22.4: only real processed sessions; badge "Recorded run (fallback)" on every screen showing it; off unless `DEMO_FALLBACK_ENABLED`; bundles git-ignored.
- Test: Playwright asserts the badge is present on 03, 17, 19, 25 for a fallback session.

### T1.33 Public README, privacy and secret audit
- Depends on: T1.31
- Files: `README.md`, `docs/privacy.md`, `scripts/secret-scan.sh`
- Accept: README has "Built during the Hackathon", names each Meta model and its job, setup steps, spike numbers (no untested claims), no "community cricket", no part-time share claims; gitleaks over the full history is clean; no footage or transcripts in the tree.
- Test: `scripts/secret-scan.sh`; `scripts/copy-lint.sh` greps for banned phrases (SPEC §2).

### T1.34 [HUMAN] Demo video
- Depends on: T1.30, T1.32
- Files: `docs/demo/shot-list.md`
- Accept: ≤ 3 min, storyboard SPEC §21, opening line about pre-existing vs built this week; adults-only footage; hero session follows one selected player.
- Test: RUNBOOK pre-demo checklist.

M1 task count: **35** (T1.01–T1.35), plus **6** M0 tasks (T0.1–T0.6). IDs are not renumbered; T1.35 sits in M1a and the "Ready to test now" chunk.

---

## Extras (only after M1 is green; reverse cut order)

| ID | Extra | Cut it reverses | Depends on | Flag |
|---|---|---|---|---|
| X5 | A/B candidates for stage 6 + screen 28 dev runs view | 3 | T1.29 | `FEATURE_DEV_RUNS_VIEW` |
| X4 | Re-place this mark (19): re-runs 3–7 for one remark with the next registry worker; "Finding a new spot…", Undo | 4 | T1.24 | `FEATURE_REPLACE_MARK` |
| X3 | Extra fallback workers: rules splitter, "2 s before the remark" moment heuristic, rules placer, alternate segmenter | 5 | T1.20 | config `fallbackWorker` |
| X2 | Critic agent for stage 7 | 5 | T1.20 | config `critic.enabled` |
| X6 | Fireworks / Baseten providers [KEYS] | 2 | T1.08 | config `provider` |
| X7 | Gemini provider [KEYS], only if G1 = yes | 2 | T1.08 | config `provider` |
| X1 | In-page recording 09–11 | — | T1.06 | `FEATURE_IN_PAGE_RECORDING` |
| X8 | Mask-shaped highlight | — | T1.21 | `allowedMarkTypes` |

Each extra needs acceptance criteria and a test written here before it starts.
