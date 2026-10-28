# AGENTS.md: how to work in this repo

For coding agents (Codex) and humans. Read this, then SPEC.md (what to build), TASKS.md (in what order), WORKPLAN.md (who builds what in parallel), DECISIONS.md (what is still open). SETUP.md and RUNBOOK.md are for Bala.

## Non-negotiable rules

1. **Never commit secrets.** Secrets come from env vars only. `.env.example` holds names, never values. No keys, tokens, link codes, signed URLs or Clerk/Convex/Modal/R2/Meta credentials in code, tests, fixtures, logs, commit messages or docs. gitleaks runs in pre-commit and CI; do not bypass it (`--no-verify` is forbidden).
2. **Keep the M1 path working at every step.** After every task: upload → status → review → share → student must still pass (`pnpm check`, and `pnpm e2e` once T1.31 exists). Swap fakes for real workers one stage at a time. Never leave `main` red.
3. **No placeholder or fake data in anything that ships.** No lorem ipsum, invented names, made-up coach remarks or example numbers in UI, seed or docs. Synthetic test data lives only in `fixtures/synthetic/` and is never loaded by the running app. A demo fallback is a real processed session, labelled "Recorded run (fallback)" on screen (SPEC §22.4).
4. **Coach words are verbatim.** Copy them from `transcriptTurns` by `turnId` in code. Models return ids and spans only. Byte-compare on persist.
5. **Marks show what the coach said.** No bat, ball, speed, angle, distance, biomechanics or scores, in code, prompts or copy.
6. **No bulk approve**, anywhere. AI items stay dashed and unapproved until the coach approves each one.
7. **No model names on coach or student screens.**
8. **Copy rules:** pitch to cricket coaches in general; never write "community cricket"; no claims about how many coaches are part-time; Meta glasses only as a possible future capture option; never "AI coach" or "video analyzer"; never claim a capability the spike hasn't shown.
9. **Footage rule:** only adults who agreed to be filmed. Never commit video, audio, transcripts, masks or tracks of real people.
10. **Every Modal sandbox is released** in a `finally` path, and the sweeper covers crashes. Any code path that creates a sandbox without a matching terminate is a bug.
11. **Pending decisions** (`DECISION PENDING (Bala)`) are built as their default behind config or a flag. Do not hard-code either answer.
12. **Untested vendor behaviour** is marked `UNTESTED` in code comments and docs until the spike or a live test proves it. If vendor docs differ from SPEC, follow the vendor, keep the contract, and log it in RUNBOOK.md.
13. **Branches and PRs; no other outside actions.** Work on your own feature/lane branch (`lane/<lane>-<short-topic>`), push that branch, and open a PR to `main`. Never push directly to `main`, never force-push `main`, never merge your own PR: Bala reviews and merges. Each PR description lists the TASKS.md IDs it covers and their acceptance tests, with the test commands run and their passing output. Do not create repos, post anywhere else or contact anyone.

## Build order

0. **Start with TASKS.md "Ready to test now"**: no paid keys. One person is tracked per session (the subject the coach taps).
1. M0 spike tasks (T0.*) are run with Bala (keys and real clips). Code tasks can start in parallel with the fake provider.
2. Shared contracts first: T1.01 → T1.02 → T1.03. Nothing else merges until the contracts are frozen (WORKPLAN IC1). Changing a contract later needs a SPEC.md edit in the same change.
3. Walking skeleton with fake workers (M1a) → real stages one at a time (M1b) → review, share, student (M1c) → ship (M1d).
4. Extras only after M1 is green, in reverse cut order (TASKS.md).

## Layout

```
AGENTS.md SPEC.md TASKS.md WORKPLAN.md DECISIONS.md SETUP.md RUNBOOK.md README.md .env.example
apps/web/                 Next.js app: UI screens + VM HTTP API (route handlers), storage adapters, link logic
convex/                   Convex schema, queries, mutations, HTTP actions (/svc, /worker)
packages/contracts/       JSON Schemas (source of truth) + generated TS types
runner/netsense_runner/   Python runner that runs inside a Modal sandbox: DAG, stages, adapters, providers
services/orchestrator/    Python orchestrator + sweeper on the VM: claim jobs, sandbox lifecycle
prompts/                  Versioned agent prompts (one file per agent stage)
config/                   pipeline_config seed, prices
infra/modal/              Modal image/app definition
infra/vm/                 systemd units and install script for the instabox VM
spike/                    M0 feasibility scripts (clips and outputs git-ignored)
scripts/                  CLIs: contracts gen, runs/cost views, demo export/import, secret scan
tests/e2e/                Playwright end-to-end tests
fixtures/synthetic/       Synthetic test-only data (never loaded by the app)
docs/design/              Wireframes (design reference) and flow diagram
docs/spike/               Spike results (numbers only, no footage)
```

## Commands

(Defined by T1.01; keep these names.)

| Command | Does |
|---|---|
| `pnpm install` | install JS deps |
| `pnpm dev` | Next.js dev server + `convex dev` |
| `pnpm check` | lint + typecheck + unit tests (JS and Python) + contracts drift check |
| `pnpm contracts:gen` / `pnpm contracts:check` | regenerate / verify TS and Pydantic types from JSON Schemas |
| `pnpm test` | JS unit tests (vitest, convex-test) |
| `cd runner && uv run pytest` | runner tests |
| `cd services/orchestrator && uv run pytest` | orchestrator tests |
| `pnpm e2e` | Playwright with `provider=fake`, `SANDBOX_DRIVER=local`, `STORAGE_DRIVER=local` |
| `pnpm smoke:live` | one real clip through the real pipeline (needs keys and a real clip) |
| `pnpm orchestrator` | run the orchestrator locally |
| `pnpm runs:show <jobId>` / `pnpm runs:sandboxes --open` / `pnpm cost:today` | observability CLIs |
| `pnpm config:new` / `pnpm config:activate <v>` / `pnpm jobs:requeue <jobId>` / `pnpm jobs:retry <jobId> <stage>` | config versions and job re-queue (RUNBOOK §3.1, §2) |
| `pnpm demo:export <sessionId>` / `pnpm demo:import` | labelled demo fallback (SPEC §22.4) |
| `pnpm check:env` | verify every name in `.env.example` is set (prints names only, never values) |
| `scripts/secret-scan.sh` | gitleaks over the working tree and history |

## Conventions

- TypeScript strict; no `any` in contract code. Python 3.12, type hints, `ruff` + `mypy --strict` on `runner/` and `services/`.
- Contracts: edit `packages/contracts/schemas/*.json`, then `pnpm contracts:gen`. Never hand-edit generated files.
- Stage workers implement `StageWorker` (SPEC §6.2), never write to Convex directly, and are pure with respect to their inputs (same input → same idempotency key).
- Prompts are files in `prompts/` with a version header; the runner records `promptHash`.
- Errors use codes from `ErrorCode.json`; user-facing copy maps codes to screens (SPEC §15).
- UI: mobile first (390 px wide), accent `#4D672A` only for the main action, active item, fallback badge; coach vs AI by shape and label, not only colour. Screen numbers in component names or comments (`// Screen 19`).
- Logs are JSON lines, scrubbed: no secrets, tokens, codes, signed URLs, transcript text or notes.
- Feature flags and config, not branches, for cuts (SPEC §17).
- Small changes, each with tests. Commit messages in plain English; no secrets.

## Definition of done (per task)

- Acceptance criteria in TASKS.md met; the listed test exists and passes.
- `pnpm check` green; `pnpm e2e` green (once it exists); the M1 path still works.
- Contracts and SPEC.md updated together if an interface changed.
- No new secret, real-person media or example data in the tree (`scripts/secret-scan.sh`).
- New vendor behaviour marked `UNTESTED` until proven; anything learned goes into RUNBOOK.md "Log / refinements".
- For sandbox code: a test proves the sandbox is terminated on success, failure and timeout.
- Any pending decision touched stays configurable.
