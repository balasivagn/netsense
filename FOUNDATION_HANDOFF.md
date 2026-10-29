# L0 foundation handoff — T1.01–T1.03

Base: `origin/main` at `d5f05681e2cd67bef2484175cc0ec610120f51b5`. Branch: `lane/l0-contracts-foundation`. This is a local foundation candidate for parent review. **IC1 is not deployed or merged.** Bala owns merging; no dependent lane should treat this document as merge approval.

## Frozen candidate interfaces

`packages/contracts/manifest.json` lists all **34 draft-2020-12 schemas**, their aggregate digest, and individual digests of the Convex foundation source and seed. Schema digest: `51a8bd5650004181dcdb0ede8c9231fb083e8f6470e976ba0a4e0a7fbc7c0078`. `pnpm contracts:check` regenerates into `.orca-scratch`, compares exact output, and rejects changed/missing/stale generated modules or a changed manifest. Any contract change requires a SPEC edit and regeneration in the same change.

- Schema source: `packages/contracts/schemas/*.json`. It covers all nine stage pairs, subject anchor, four primary model outputs, critic and next-focus outputs, common subject/provenance types, track files, config, stage run and errors. Generated TypeScript is in `packages/contracts/gen`; generated Pydantic and bundled source schemas are in `runner/netsense_runner/contracts`.
- Python callers should use `netsense_runner.contract_validation.validate_contract(name, json_payload)` at runtime boundaries. It applies the original JSON Schema and then parses the named generated Pydantic model. Generated types alone do not enforce every JSON Schema record-key/uniqueness constraint. Both languages have tested UTF-16 span-copy helpers; word-boundary checks and byte-checked persistence remain T1.10/T1.15/T1.19.
- Model schemas contain external references in source. The Spark linter resolves those references before checking depth, closure, required properties, forbidden unions and recursion. Later adapters must inline/bundle references and specialize frame/box/turn-id enums before sending schemas to a model. No model call or live schema acceptance is claimed.
- `convex/schema.ts` defines all **18 M1 tables** and specified indexes, without `consents`. Every coach-owned row has `coachId`; config is global. The snapshot is a typed projection, and parsed agent output is a generated union of model outputs. See SPEC's foundation clarifications for field-level refinements.
- Public functions: `coaches.ensure`, `students.add/list`, `sessions.create/list/get/setRenderMode/setSubject`, `config.active`. All use real Convex identity and ownership checks. No fake auth exists. `sessions.create` takes `studentId`, `subjectRole`, `captureMode`; `setSubject` takes `sessionId`, `frameMs`, normalized `point`, `role`, and stamps `selectedAt` server-side.
- Internal functions: `config.seed`, `jobs.enqueue` (initial pipeline only), `jobs.enqueueWhenReady`, `jobs.claim`, `uploads.complete`, `stageRuns.start/finish`. `uploads.complete` requires an existing upload, owner id, verified byte count, optional measured duration; storage verification and authenticated HTTP wrappers belong to the later lanes. `jobs.claim` takes `leaseOwner` and returns one atomically leased job or null. All config/usage/rollup decisions use the pinned version.
- Identical completion/tap retries reuse one pipeline job. A changed tap before claim updates that job's inputs; after a terminal initial job it creates `subject_retrack`, clears anchor and AI approvals, and preserves coach/deleted marks. Same-tap retry is allowed after `anchor_failed`. Running jobs and queued retracks block changed taps with `JOB_IN_PROGRESS`; the future UI must surface this conflict. No running subject replacement/cancellation flow is implemented.
- Stage start derives worker/provider/model from pinned config and validates attempt limits, remark membership and idempotency identity. Finish is immutable, updates usage once, and rolls up the first unfinished coach row, including the separate subject anchor and tracked remark branches. Raw `errorDetail` is rejected pending the later scrubber. Other job-kind action entry points, service/worker authentication, heartbeats, persistence, sandbox lifecycle and recovery remain later work.

## Local verification

All commands below use no runtime credentials or paid APIs. Exact final results are recorded in the PR and TASKS acceptance evidence.

- `pnpm install` and `pnpm install --frozen-lockfile`: successful; real pre-commit hook installed.
- `pnpm check`: ESLint and both strict TypeScript projects pass; **98 JS tests** in **8 files** pass; Ruff passes; strict mypy passes for **43 source/test files** (41 runner, 2 orchestrator); runner **95 tests** and orchestrator **1 test** pass; **34 contracts** match generated output; **6 model-output schemas** pass Spark structural limits; offline Convex bindings match.
- `pnpm test:contracts`: **76 JS tests** in **3 files**, **94 Python contract tests** pass.
- `cd runner && uv run pytest`: **95 passed**. `cd services/orchestrator && uv run pytest`: **1 passed**. Bootstrap tests verify installed package imports under Python 3.12 without importing vendor clients.
- `pnpm contracts:test-drift`: deliberately appends to generated `Subject.ts`, requires `contracts:check` to exit 1 with that path, restores it in `finally`, then requires the clean check to pass.
- `pnpm --filter @netsense/web build`: successful Next.js production build; only the empty shell and framework not-found route exist.
- `scripts/secret-scan.sh`: real gitleaks scans history and all tracked/nonignored working-tree source, with redacted output. No exclusions were added for findings. The hook also runs at commit.
- `.github/workflows/ci.yml` installs pinned tooling, runs checks/contracts/drift-negative/build/full secret scan and pre-commit. Remote execution is not assumed from local success.

## Downstream and external checks

Install with Node 22, pnpm 12.15.0, uv and Python 3.12. `scripts/install-gitleaks.sh` provides the real scanner inside ignored `.orca-scratch/tools` if it is absent from PATH. `pnpm check:env` prints missing names only and deliberately fails when values are absent; do not fill it with invented credentials.

The ordinary Convex CLI required `CONVEX_DEPLOYMENT`; local bindings were generated from the pinned SDK's official templates with `pnpm convex:codegen`. **UNTESTED:** real Convex deploy and transaction execution, Clerk issuer/JWT integration, all Meta/Modal/R2 behavior, real-media processing, end-to-end M1. T1.04 must configure real auth; T1.10 must authenticate every privileged wrapper and map optional Convex fields to nullable JSON wire fields. Do not expose internal functions publicly for convenience.

The server-keyframe fallback still contradicts the tap gate: transcode cannot produce fallback keyframes before a subject-gated pipeline starts. T1.12/T1.35 need a reviewed solution. No fallback or full upload/status/review/share/student path is claimed. E2E is not present yet (T1.31); no passing stub was added. Feature flags and pending defaults stay configurable; live rates and sandbox pricing remain unvalidated.

A second runner integration edge remains: after a failed initial pipeline (especially `SUBJECT_NEEDED` at the anchor), a subject-retrack job may not yet have every moment output that §6.5 says to reuse. This foundation only creates the typed job; T1.09 must define missing-prerequisite handling before executing such a retrack. Do not assume absent artifacts exist. `pnpm check:env` currently reports 59 missing names as expected; no values were supplied.
