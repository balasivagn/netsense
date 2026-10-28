# RUNBOOK: running, fixing and operating NetSense

For Bala and the coding agent. Times in SGT. Anything marked **UNTESTED** has not been run for NetSense yet; once it has been, remove the mark and add a row to the log at the bottom.

Note: early test clips may lack commentary; that's a test-data gap, not a product mode.

## 1. Running

### 1.1 Locally (fake pipeline, no paid calls)
```bash
cp .env.example .env.local        # fill Clerk + Convex dev values (SETUP 2, 3)
pnpm install
export NETSENSE_ENV=dev SANDBOX_DRIVER=local STORAGE_DRIVER=local LOCAL_STORAGE_DIR=$PWD/.local-media
pnpm dev                          # Next.js + convex dev
AGENT_PROVIDER_DEFAULT=fake pnpm orchestrator   # fake provider: test-only, refuses prod
scripts/make-synthetic-clip.sh /tmp/synthetic.mp4   # synthetic test clip, never a real person
```
Open `http://localhost:3000`, sign in, create a session (student + role), upload `/tmp/synthetic.mp4`, tap the person to follow on 07a, watch screen 12.

### 1.2 Locally with real models
Same as 1.1 but with `MODEL_API_KEY` set and `AGENT_PROVIDER_DEFAULT=meta`, and a real clip (adults who agreed to be filmed). Keep `SANDBOX_DRIVER=local` to avoid Modal, or set `modal` with the Modal token (SETUP 4). Check `pnpm cost:today` afterwards.

### 1.3 On the VM
```bash
ssh <vm>       # or the instabox shell
cd /data/netsense/app && git pull && pnpm install && pnpm build
sudo systemctl restart netsense-web netsense-orchestrator
curl -s https://<public-url>/api/health
journalctl -u netsense-orchestrator -f      # JSON logs
```
Free plan: the VM pauses after 30 min idle; open the public URL to wake it, then wait for `/api/health` to show a recent `orchestrator.lastPollAt`. **UNTESTED:** whether the orchestrator's polling keeps the VM awake.

### 1.4 The M0 spike on real clips (UNTESTED)
```bash
cd spike && uv sync
cp ~/clips/*.mp4 ~/clips/*.mov clips/          # git-ignored
bash transcode.sh clips/<clip>
uv run python transcribe.py clips/<clip>.wav
uv run python pick_subject.py clips/<clip>.proxy.mp4 --deliveries deliveries.csv   # Bala clicks the one person once per clip
uv run python sam_image.py clips/<clip>.proxy.mp4 --deliveries deliveries.csv --anchor  # point prompt at the tap -> box + reference crop
uv run python sam_window.py clips/<clip>.proxy.mp4 --deliveries deliveries.csv --subject # follow only the subject per delivery; review MP4s in out/
uv run python subject_probe.py clips/<clip>.proxy.mp4 --deliveries deliveries.csv       # S-4 re-identification
uv run python modal_smoke.py
uv run python report.py > ../docs/spike/sam-spike.md
```
`deliveries.csv` = one row per delivery or segment: `clip, delivery, startMs, endMs, subjectFrameMs, subjectX, subjectY` (times marked by eye; subject columns written by `pick_subject.py`). For S-3, watch each review MP4 and mark it followed / swapped / lost in `out/s3_marks.csv`; a swap to another person on any delivery counts against the ≥ 4/5. Then fill the verdict (TASKS T0.6): Go / Partial (Still frames only) / No-go, and set `renderModeDefault`.

### 1.5 One video end to end
1. Sign in on the phone → + New session → pick the student and their role → Record or Upload → tap the person to follow (07a).
2. Watch screen 12 until "Prepare preview" finishes (or an error screen appears).
3. In a terminal: `pnpm runs:show <jobId>` (job id is on the session in Convex) to see each stage's status, worker, latency and cost.
4. Playback (17) → Review marks (19) → approve each → Edit notes (21) → Continue to share (22) → Create private link (23).
5. Open the link on a second device, enter the code → lesson (25) → focus (26).
6. Confirm the finalize job ran and its sandbox was released (1.7).

### 1.6 Watching stageRuns and status in Convex
- Convex dashboard → Data → `jobs`: `status`, `coachStage`, `progressLabel`, `errorCode`, `heartbeatAt`, `sandboxId`, `costUsd`.
- `stageRuns` filtered by `jobId`: one row per attempt; `status`, `errorCode`, `workerId`, `latencyMs`.
- `annotations.provenance` on any mark: which config, workers and stage runs produced it.
- CLI: `pnpm runs:show <jobId>`, `pnpm config:show`.

### 1.7 Confirming the Modal sandbox was released (UNTESTED)
```bash
pnpm runs:sandboxes --open        # should print nothing when no job is running
```
Cross-check in Modal: dashboard → Apps → `netsense-runner` → no running sandboxes; or
```bash
uv run --with modal python -c "import modal; a=modal.App.lookup('netsense-runner'); print(list(modal.Sandbox.list(app_id=a.app_id, tags={'app':'netsense'})))"
```
Every `sandboxes` row should have `terminatedAt` and `terminatedBy`.

## 2. Common failures and fixes

| Symptom | Likely cause | Fix |
|---|---|---|
| Sandbox still running after the job ended (leak) | Orchestrator crashed or VM paused before `finally` | Sweeper kills it within `SWEEPER_INTERVAL_S` once the VM is awake; Modal `timeout` ends it anyway. Manually: `pnpm runs:sandboxes --open --terminate` (asks first). Log it below and add a test for the path that leaked. |
| Job stuck `running`, no heartbeat | Sandbox died, network, or VM paused | Sweeper marks `SANDBOX_LOST` and the job retries (resumes from the last done stage). If attempts are used up: `pnpm jobs:requeue <jobId>`. |
| Sandbox hits its timeout | Long video, slow SAM | Check `stageRuns` latency per window; raise `SANDBOX_TIMEOUT_CAP_S` or turn on `downsampleFps: 15` in a new config version; check `MAX_VIDEO_MINUTES`. |
| `SEG_NO_TRACK` on many remarks / screen 15 | SAM can't follow the selected person in this footage | Coach taps "Use still frames only" (→ 18). If it happens across sessions: set `FORCE_STILLS=1` (cut 12) and say "Still frames only" in the demo. |
| `SUBJECT_NEEDED` / 07a shown again | Upload done but no tap yet, or nothing found at the tapped point | Coach taps the person again on a clearer frame. |
| `SUBJECT_NOT_FOUND` / screen 16 | Selected person off-frame at that moment, or re-identification unsure (similar kit, crowded net) | Coach uses Tap them / Note only / Still frame. If frequent: pick the tap frame where the person is large and unblocked; check `stageRuns` `why` for the re-id step; keep the camera still. |
| `SUBJECT_SWAP` / screen 16 "Tracking may have jumped to someone else" | Another person crossed in front; SAM id moved to them | Coach taps the right person at that moment (`remark_retrack`). If frequent: lower `trackPadMs` (shorter windows), raise `swapIouMin`, or try `downsampleFps` off. Log it below. |
| Wrong person followed for the whole session | Tap landed on someone else | Review → "Change who to follow" (`subject_retrack`). |
| `TRANSCRIBE_FAILED` / screen 13 | API error, 10 min / 32 MB limit, rate limit | Check chunking (≤ 9.5 min chunks); retry from 13; else coach adds remarks by hand. |
| `AUDIO_DECODE` | No audio track or unsupported codec | Re-record with sound on; check `ffprobe` of the source. |
| `NO_SPEECH` / screen 14 | Coach too far from the phone, wind | Advice: keep the phone near the coach, or use the typed remarks path. |
| `RENDER_FAIL` | ffmpeg error, font, memory | Playback falls back to the live overlay automatically. Read `stageRuns.errorDetail`; re-run with `pnpm jobs:retry <jobId> render`. If render keeps failing: `FEATURE_FFMPEG_RENDER=0` (cut 7). |
| Student: "wrong code" | Typo, or code copied with spaces | Codes are 6 digits; spaces are stripped. After 5 wrong tries: 15 min lock; wait or create a new link. |
| Student: link stopped (27) | Expired (30 days) or turned off | Create a new link from screen 22. |
| Coach can't sign in | Clerk origin / redirect URL missing for the VM URL | Add the URL in Clerk (SETUP 2.4). |
| Convex "Unauthenticated" | Clerk issuer env missing on that deployment | `convex env set CLERK_JWT_ISSUER_DOMAIN ...` on the right deployment. |
| Signed URL 403 | Expired (TTL) or clock skew | Reload the page (URLs are re-signed); check VM clock. |
| `BUDGET_*` | Cap reached | `pnpm cost:today`; raise the cap only on purpose; Meta's spend limit is alert-only. |

## 3. Operations

### 3.1 Switching the agent provider (Muse Spark vs Gemini) and fallbacks
`DECISION PENDING (Bala)` G1. Jobs pin their config, so switching never affects a running job.
```bash
pnpm config:show                          # current active version
pnpm config:new --from active --set 'stages[plan,moment,subject,place].provider=gemini' --set 'stages[plan,moment,subject,place].model=<gemini-model-id>' --note "G1: Gemini for agents"
pnpm config:activate <version>
```
Rollback: `pnpm config:activate <previous version>`. Same pattern turns on the critic (`stages[check].critic.enabled=true`), fallback workers (`fallbackWorker`), or still frames (`params.renderModeDefault=stills`). `config:new` and `config:activate` are built in T1.29; **UNTESTED** until then. Gemini requires X7 and `GEMINI_API_KEY`.

### 3.2 Cost check
```bash
pnpm cost:today                 # by provider and stage, from costLedger
pnpm runs:show <jobId> --cost   # one job
```
Compare against the Meta Billing page and the Modal usage page weekly. Target from the spike: ≤ ~$1.50 per session (S-6). Update `config/prices.json` if prices change.

### 3.3 Pre-demo checklist
- [ ] **Wake the VM** (free plan, I1): about 10 minutes before the demo, open the public URL (`APP_BASE_URL`); wait until `curl -s <public-url>/api/health` returns ok and shows `orchestrator.lastPollAt` within the last minute. Keep it awake by reloading if the demo starts more than 30 minutes later.
- [ ] VM awake; `/api/health` ok; orchestrator polled in the last minute.
- [ ] `pnpm runs:sandboxes --open` empty.
- [ ] `pnpm cost:today` well under `DAILY_SPEND_LIMIT_USD`.
- [ ] Footage: adults who agreed to be filmed; no minors (D3); the consent checkbox was ticked for every session shown (`consentConfirmedAt` set; C-C, D2).
- [ ] One fully processed real session ready; demo fallback exported (`pnpm demo:export`) and badge checked.
- [ ] Student link created; code noted privately; second device ready.
- [ ] No model names on coach/student screens; footer line visible on 25.
- [ ] No "community cricket", no part-time claims, no bat/ball/biomechanics claims in on-screen text or voice-over.
- [ ] If tracking is not shown working: say "Still frames only" and why.

### 3.4 Demo recording steps (SPEC §21)
1. Phone screen recording on (1080p), Do Not Disturb on.
2. 0:00–0:10 opening line: what existed before 27 Oct vs built this week; name Muse Voice Transcribe, Muse Spark, SAM 3.1.
3. 0:10–0:30 capture and upload (show resume if natural); tap the player to follow.
4. 0:30–0:55 screen 12, then `pnpm runs:show` or the Convex `stageRuns` table.
5. 0:55–1:45 annotated playback: coach's words on the one selected player (others in the net ignored), Hear coach.
6. 1:45–2:15 review: approve, move, AI suggestion approve/dismiss; mention no bulk approve.
7. 2:15–2:40 student: link, code, lesson, footer line.
8. 2:40–3:00 focus card, next-session focus, close.
9. If the live run fails, use the "Recorded run (fallback)" session and keep the badge visible.
10. Check length ≤ 3:00 and upload per the hackathon guide.

## 4. Log / refinements

| Date (SGT) | What happened | Change made |
|---|---|---|
| Wed 28 Oct 2026 | Build spec v1 written (SPEC, TASKS, WORKPLAN, DECISIONS, SETUP, RUNBOOK) | — |
| Wed 28 Oct 2026, 3 PM | Bala: clips have several people, focus on one | Spec v1.1: one selected subject (F1, scope reduction), spike S-2…S-4 rewritten for the selected person, "Ready to test now" chunk added. A short-lived "no voice" schedule change (commit 9e65852) was reverted the same afternoon: missing commentary in early clips is a test-data gap, not a product change. |
| Wed 28 Oct 2026, 3:15 PM | Bala: Codex pushes its own branch and opens PRs to `main` | AGENTS.md rule 13, WORKPLAN, SETUP §9 updated; Bala reviews and merges |
| Wed 28 Oct 2026, 5 PM | Bala's decisions (relayed via Chief of Staff): C-C/D2/D3 minimal consent checkbox; S1 R2; I1 free plan; D8 blocked until Bala confirms | SPEC, TASKS (new T1.37), WORKPLAN (L4), DECISIONS, SETUP steps 1/5/6, RUNBOOK §3.3, `.env.example`, README. Still awaiting Bala: G1, C-P, M1, F4 (07a design), MW. |
| Wed 28 Oct 2026 | T1.04 Clerk/Convex wiring | Next 16.4.3 uses `proxy.ts` (not `middleware.ts`). Proxy is only an early route filter; session layout and future coach route handlers still authenticate independently. Clerk ↔ Convex acceptance and real sign-in remain **UNTESTED** until SETUP steps 2–3 provide a configured Clerk instance, Convex deployment and `convex` JWT template/integration. |
| | | |

### Foundation log / refinements — 28 Oct 2026

T1.01–T1.03 add a no-key scaffold, schema generation, and internal Convex foundation. See `FOUNDATION_HANDOFF.md` for the exact verified commands and boundaries; SPEC's foundation clarification records the nullable fields, provenance maps, config limits, snapshot projection, tap concurrency rule, and rollup semantics.

- Local bindings come from the pinned Convex SDK's own templates via `pnpm convex:codegen`. The normal CLI refused to run without `CONVEX_DEPLOYMENT`; no credential or deployment was invented. These bindings typecheck and run in `convex-test`, but **Convex deployment, Clerk JWT acceptance, and real transaction behavior remain UNTESTED**. After supplying the real deployment in T1.04, use the official `convex dev`/`convex codegen` path and review any generated changes.
- TypeScript 6.0.3 is pinned because the installed typescript-eslint 8.72.1 explicitly rejects TypeScript 7.0.2. Next.js 16.4.3 builds with the pinned toolchain. Library API references: [Convex test](https://docs.convex.dev/testing/convex-test), [Next.js TypeScript](https://nextjs.org/docs/app/api-reference/config/typescript); generation flags and validators were checked against installed package source/help.
- The pinned Python generator drops numeric constraints with its `--strict-types` option and supplies defaults for required nullable fields. Generation instead uses a strict Pydantic base, annotated constraints, and removes `None` defaults only after asserting that every wire property is required. Shared negative tests cover these cases. `validate_contract` also applies the original JSON Schema, which is authoritative for record-key restrictions and uniqueness that generated model types do not completely express.
- Real gitleaks 8.30.0 is downloaded from its official release with a release-checksum check into `.orca-scratch/tools` when unavailable on PATH. The pre-commit hook invokes the real staged scanner; `scripts/secret-scan.sh` separately scans all Git history and tracked/nonignored working-tree source. Install via `scripts/install-gitleaks.sh`, then `pnpm install` installs the hook through pre-commit. No hook bypass is permitted.
- No sandbox, paid stage, upload/storage service, real media, sample UI content, or credential fallback is introduced. M1 E2E does not exist until the later lanes/T1.31. The server-keyframe/tap-gate contradiction remains unresolved; IC1 deployment and Bala's merge are pending.
- Runner integration must also resolve subject-retrack after an initial anchor failure: per-remark moment artifacts may not exist yet. The foundation does not execute a retrack or claim those prerequisites were produced.

### Runner interface review — 28 Oct 2026

- T1.08 uses the documented Chat Completions `text`/`image_url` content shape; `input_text` belongs to Responses. Reference: [Meta vision input](https://dev.meta.ai/docs/cookbook/vision-input). Transport requests are unit-tested only; live Meta acceptance remains **UNTESTED**.
- Per-call frame/box/turn-id enums are enforced on responses as well as sent in requests. Invalid budget values cannot enter the counters. Arbitrary subprocess stderr is replaced with a safe marker, and process groups are released on normal completion, failure, timeout and cancellation. These parent-review fixes have regression tests; they do not constitute sandbox/orchestrator or real vendor validation.
