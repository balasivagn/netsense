# Decisions

Every open decision that affects the build. Each one is `DECISION PENDING (Bala)` until Bala answers. The build implements the **default** and keeps it configurable, so an answer changes config or a flag rather than code. When a decision lands: change the status, add the date (SGT), update the config or flag, and add a row to RUNBOOK.md "Log / refinements".

Dates are 2026, Singapore time (SGT, UTC+8). Today is Wed 28 Oct.

## Pending

| ID | Decision | Default built | Where it lives | Deadline (SGT) | Status |
|---|---|---|---|---|---|
| G1 | Use Gemini for agent stages? | Muse Spark 1.3 for all agent stages; Gemini adapter is a stub | `pipeline_config.stages[].provider`; `AGENT_PROVIDER_DEFAULT`; X7 | Thu 29 Oct | DECISION PENDING (Bala) |
| D9 | Any non-Meta model (Gemini, faster-whisper contingency) and how to disclose it | None; faster-whisper is contingency only | README models section; config | with G1, Thu 29 Oct | DECISION PENDING (Bala) |
| S1 | Video storage: private R2 bucket with expiring links, or VM disk | R2 adapter is the proposal (PROPOSAL §3d); dev runs `local`; VM disk is cut 11 | `STORAGE_DRIVER` | Wed 28 Oct | DECISION PENDING (Bala) |
| C-C | No in-app consent step in the hackathon build (designer-reported, needs Bala's confirmation) | No consent step; screen 22 line "Hackathon build: demo uses adults who agreed to be filmed. A consent step for juniors comes in a later version." | SPEC §3, screen 22 copy | confirm Wed 28 Oct morning (overdue if not yet confirmed) | DECISION PENDING (Bala) |
| D2 | Off-app agreement record for people filmed | Bala keeps a written note per person filmed, outside the app and the repo | RUNBOOK pre-demo checklist | Wed 28 Oct morning | DECISION PENDING (Bala) |
| D3 | Can minors be filmed? | No. Adults who agreed only, for spike and demo | AGENTS.md rules, RUNBOOK | before T0.2 | DECISION PENDING (Bala) |
| D5 | Retention period for footage and lessons | Keep until the coach deletes the session; nothing auto-deletes; `scripts/purge-session.ts` | SPEC §12 | before T1.30 (Mon 2 Nov) | DECISION PENDING (Bala) |
| D6 | Use of public footage | None used | — | before T1.34 | DECISION PENDING (Bala) |
| D4 | Student link method | Private link + 6-digit code, 30-day expiry, download off, 5 wrong codes → 15 min lock | `LINK_TTL_DAYS`, `FEATURE_LINK_EXTRAS`, SPEC §14 | Fri 30 Oct | DECISION PENDING (Bala) |
| I1 | Is Bala on the instabox free plan? (30-min idle pause can't be turned off on free; on paid run `instabox auto-suspend <machine> 0`) | Assume free plan: Modal `timeout` bounds cost while the VM is paused; wake the VM before demos | SETUP step 6, RUNBOOK | before T1.30; ideally today | DECISION PENDING (Bala) |
| C-P | Modular 8-stage pipeline (stage interface, registry, stageRuns, provenance) | Built as specified | SPEC §6 | Thu 29 Oct | DECISION PENDING (Bala) |
| M1 | Minimum version and cut order | M1 as in SPEC §22.2; cuts 1–5 applied; 6–9 decided at checkpoints; 10–12 last resorts | feature flags SPEC §17 | Thu 29 Oct | DECISION PENDING (Bala) |
| A1 | Approve the proposal | Build proceeds on R10 | — | — | DECISION PENDING (Bala) |
| D8 | Meta API account, card, credits | Needed for M0; check credit status | SETUP step 1 | before T0.3 | DECISION PENDING (Bala) |
| MW | Modal workspace name (for the credit request); what if credits don't arrive | Pay-as-you-go if needed; else `SANDBOX_DRIVER=local` (VM runner) | `SANDBOX_DRIVER` | before T0.4 | DECISION PENDING (Bala) |
| B1 | Remarks not about the selected person (reworded after F1; was "remarks about the bowler in the batter's lesson") | Kept as note-only and left out of the share by default; coach can include one by one on 19 | `params.otherPersonRemarksInShare` | before T1.27 (Sun 1 Nov) | DECISION PENDING (Bala) |
| F4 | Screen 07a "Pick who to follow" has no wireframe | Build with existing components; send screenshots to Bala (or the designer) at IC2 | SPEC §4 screen 07a | Thu 29 Oct | DECISION PENDING (Bala) |
| Q-l | Bala's availability for clips, checkpoints and demo | Checkpoints Thu 29, Sat 31 Oct, freeze Mon 2 Nov, demo Tue 3 Nov, package to Bala Wed 4 Nov 2 PM | WORKPLAN | — | DECISION PENDING (Bala) |
| P2 | Wireframe PNGs in a "new work only" public repo | Copied to `docs/design/` as design references (made 27 Oct ~22:26–22:31 SGT, after kickoff), labelled as containing example text | `docs/design/README.md` | before the repo goes public | DECISION PENDING (Bala) |
| Q7 | How a coach's transcription correction is shown | "corrected by coach" tag; Hear coach plays the original audio | SPEC §4.3 | — | DECISION PENDING (Bala) |

## Decided (inputs to this spec)

| Decision | By | Notes |
|---|---|---|
| instabox VM hosts app server and orchestrator | Bala | SPEC §5 |
| Convex for data and real-time status; Clerk for auth | Bala | SPEC §9, §13 |
| One ephemeral Modal Sandbox per uploaded video; always released; final render in a fresh sandbox | Bala (R10) | SPEC §11; UNTESTED until T0.4 |
| Meta Model API: Muse Voice Transcribe, Muse Spark, SAM 3.1 (Standard mode only) | Bala | SPEC §6 |
| Fireworks and Baseten are swappable backups, outside M1 | Bala | X6 |
| 8 swappable stages behind one interface with a `pipeline_config` registry, `stageRuns`, `annotations.provenance` | Bala | SPEC §6 (C-P still asks for formal approval) |
| "Still frames only" as the fallback name | PROPOSAL R9 | resolves design open question 6 |
| Daytona out | PROPOSAL cut 1 | |
| **Branches and PRs for coding agents** (Wed 28 Oct 2026). Codex works on its own feature/lane branch, pushes that branch and opens a PR to `main`; never pushes directly to `main`, never force-pushes `main`, never merges its own PR. Each PR states the TASKS.md IDs it covers and their passing acceptance tests. Bala reviews and merges. | Bala, 28 Oct 2026 | AGENTS.md rule 13; WORKPLAN top; SETUP §9 (branch protection) |
| **F1 · One person in focus** (Wed 28 Oct 2026). Clips have several people in frame; tracking follows one subject the coach selects by tapping them on a frame (new screen 07a). SAM 3.1 tracks only that person; everyone else is ignored. Batter / bowler / other is a role label on that subject, not two simultaneous tracks. **Scope reduction:** no batter/bowler pairing, no bowler picker on 04, no reassign-to-other-person on 20. | Bala, 28 Oct 2026 | SPEC §0, §4 (04, 07a, 16, 19, 20, 22), §7.4–7.7, §8.3, §22.1 S-2…S-4 (selected person tracked in ≥ 4/5 deliveries/segments, no swap; time and cost thresholds unchanged); supersedes the batter-vs-bowler resolver; B1 reworded |

## Spec-level choices (not Bala's; change with a note here)

| Choice | Why |
|---|---|
| Next.js (TypeScript) for web + VM API; Python for orchestrator and runner | Modal's documented SDK and the SAM parser are Python; one web process on the VM |
| JSON Schema as the single source for contracts, generated to TS and Pydantic | One contract for three runtimes |
| Model picks frame indices and box numbers, never times or coordinates | Keeps outputs checkable and coach words verbatim |
| R2 adapter and local adapter both built | S1 can land either way without blocking |
| Student session via signed cookie after the code check | No student accounts |
| Subject picked in the browser at upload time from the local file (screen 07a), not after transcode | No sandbox waits for the coach; the job starts as soon as both upload and tap are in |
| Subject re-found per window by Muse Spark comparing a reference crop with numbered "person" boxes, plus a position prior | SAM object ids are not stable across windows or occlusion; the model still only picks a box number |
| Per-window tracking kept over whole-video tracking | Whole-video at 15 fps ≈ 9,000 frames ≈ $1.80 per 10-min session, over the $1.50 target (unmeasured; spike may revisit) |
