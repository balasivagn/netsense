# fixtures/test-only — TEST ONLY, NEVER SHIPPED

This folder holds the **test-only remarks fixture** (SPEC §19.1, DECISIONS F2). It exists only so the transcribe and agent stages can be tested before real coach commentary is recorded (Sat 31 Oct / Sun 1 Nov 2026).

Rules:
- Files here are **not coach remarks**. Every turn's text starts with `[TEST]`, and the speaker is `TEST_COACH`.
- Loaded only by the `fixture` transcribe provider, and only when `NETSENSE_ENV` is not `prod` and `TEST_FIXTURES_ENABLED=1`.
- Sessions that use it get `usesTestFixture = true` and a red "TEST FIXTURE: not real coach remarks" banner; they cannot be shared in prod or exported as the demo fallback.
- **Never** in the demo video, screenshots, README, write-up or submission.
- Fixtures generated from real clips (real timings of a real person) go to git-ignored `local-fixtures/`, never here.
- `scripts/check-no-fixtures.ts` (CI) fails if the production bundle or runner image contains this folder or `[TEST]` strings.

Planned files (T1.36): `template.transcribe.json` (schema-valid shape), `synthetic-clip.transcribe.json` (turns timed to the synthetic test clip from `scripts/make-synthetic-clip.sh`). Stub only for now.
