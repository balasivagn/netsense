# NetSense

NetSense is a coaching-workflow tool for cricket coaches. A coach films a net session while talking through feedback as usual. NetSense turns the coach's own spoken remarks into a marked-up video and lesson notes. The coach checks and approves every mark, then shares a private lesson with the student.

> Status: in development for the Meta AI Developer Hackathon (Meta x Cerebral Valley), Indie track, 27 Oct – 4 Nov 2026. Capabilities listed below are what we are building; results will be added here after testing.

## How it works

1. **Film and talk.** Record on the phone camera or upload from the camera roll. Uploads resume if the connection drops.
2. **Hear the remarks.** Muse Voice Transcribe turns the coach's speech into timed turns.
3. **Match remarks to moments.** A Muse Spark planner splits the transcript into remarks; per-remark Muse Spark agents find the moment in the video and which player (batter or bowler) the remark is about.
4. **Follow the players.** SAM 3.1 segments and tracks that player through the moment.
5. **Place and check marks.** Circles, arrows, highlights and labels are anchored to the tracked player, using the coach's own words or a neutral label. A rules checker verifies each mark.
6. **Coach review.** Every AI placement or suggestion is a draft until the coach approves it, one at a time.
7. **Private student link.** The student opens a link plus a 6-digit code and sees the marked-up moments, the coach's words (with the original audio), and a focus card.

The marks show what the coach said. They don't measure technique: NetSense does not track the bat or ball and does not score anyone.

## Meta models and their jobs

| Model | Job |
|---|---|
| Muse Voice Transcribe (`muse-voice-transcribe-1.0`) | Coach's speech → diarized, timed turns |
| Muse Spark (`muse-spark-1.3`) | Planner agent and per-remark agents: split remarks, find moments, pick the player, place marks, draft focus points |
| SAM 3.1 (`sam-3.1`) | Find and track the batter or bowler for each remark |

## Architecture

- **Web app + API:** Next.js on an instabox VM.
- **Data and live status:** Convex. **Auth:** Clerk (coaches).
- **Processing:** one short-lived Modal Sandbox per uploaded video runs the 8-stage pipeline and is always released; the final render runs in a fresh sandbox after the coach approves.
- **Pipeline:** 8 swappable stages behind one interface, a versioned `pipeline_config`, a `stageRuns` record for every attempt, and provenance on every mark.

Details: [SPEC.md](SPEC.md). Build plan: [TASKS.md](TASKS.md), [WORKPLAN.md](WORKPLAN.md). Wireframes: [docs/design/](docs/design/).

## Setup

Requirements: Node 22 + pnpm, Python 3.12 + uv, ffmpeg, and accounts for Meta Model API, Clerk, Convex, Modal, and (if used) Cloudflare R2. Step-by-step: [SETUP.md](SETUP.md). Operating guide: [RUNBOOK.md](RUNBOOK.md).

```bash
cp .env.example .env.local     # fill in values; never commit them
pnpm install
pnpm check:env
pnpm dev                       # Next.js + Convex dev
pnpm orchestrator              # job runner (SANDBOX_DRIVER=local or modal)
```

Tests: `pnpm check` (unit, contracts) and `pnpm e2e` (end-to-end with a test-only fake provider).

## Privacy

- Coach-only sign-in; student lessons need a private link plus code, expire after 30 days, and can be turned off.
- Only items the coach approved are shared. Video links are short-lived; download is off in the player.
- Hackathon build: the demo uses adults who agreed to be filmed. A consent step for juniors comes in a later version.
- No footage, audio or transcripts of real people are stored in this repository.

## Built during the Hackathon

<!-- Fill in before submission (T1.33): what existed before 27 Oct 2026 (idea, research, design notes) vs what was built during 27 Oct – 4 Nov 2026. All code in this repository was written during the hackathon. -->

## Licence

To be chosen by the author before the repository is made public.
