# L2 HTTP lifecycle handoff — T1.10 PARTIAL

PR #5 repairs the bounded HTTP/lifecycle slice on top of `3b0c9bb`, incorporating main's `9fcd649` documentation and Bala's consent/R2 decisions. Persistence, `/worker/cost`, UI, storage, runner and schema/consent changes are outside this slice. **T1.10 remains PARTIAL** until persistence is separately implemented. No paid calls or runtime credentials were used. Live Convex deployment/crypto/transaction behavior remains **UNTESTED**; automated evidence uses the real `convex-test` HTTP router (`t.fetch`) and database transactions.

## Authentication and input

Every `/svc/*` route requires `Authorization: Bearer ${CONVEX_SERVICE_SECRET}`; an unset/empty secret denies all requests. Claim checks that `WORKER_TOKEN_SECRET` exists before invoking the atomic mutation. Secrets are runtime environment variables only. Tests generate ephemeral secrets in memory.

Worker tokens are `base64url(payload).base64url(signature)`. Payload is raw UTF-8 JSON containing exactly `{jobId,sessionId,exp}`; `exp` is integer epoch milliseconds. Signature is HMAC-SHA256 over the **raw JSON bytes**, not the encoded segment. Claim sets expiry to claim time + timeout + 300 seconds. Invalid structure, extra fields, tampering, empty/wrong secret, and `exp <= now` deny. Tokens never appear in responses except the authenticated claim response, and never in logs or errors.

Every worker query/mutation independently verifies the token and reads its job/session in the same transaction. Session pairing and coach ownership must match; ordinary access requires the session's latest job, `status=running`, and `leaseUntil > now`. Equality is expired. Only an exact terminal `/worker/done` replay may bypass running/lease checks; the token itself must still be unexpired. Service failures clear the lease, so they cannot be mistaken for worker-completion replays. A terminal replay does not touch a newer job/session.

POST JSON bodies have a streamed 32,768-byte limit, independent of absent/false Content-Length. Non-object, malformed JSON/UTF-8, unknown fields, invalid enums, nonfinite numbers and malformed table IDs fail before mutation handlers execute. HTTP ID branding is narrow: Convex `v.id` validates before entering the handler; token IDs use `db.normalizeId`. Optional request fields are omitted, not JSON null, except release `exitCode` explicitly permits null. Errors contain only fixed codes, never raw exceptions, tokens, notes or transcript text.

## Exact wire projections

All timestamps below are epoch milliseconds; IDs are JSON strings. Nullable fields are present as null. These are HTTP projections, not raw Convex documents. `PipelineConfig` is the generated contract: only `version,note,stages,coachStages,params,limits`; no `active`, `createdAt`, `_id`, or `_creationTime`.

```ts
type JobWire = {
  id: string; sessionId: string;
  kind: "pipeline" | "subject_retrack" | "remark_retrack" | "stage_retry" | "finalize";
  configVersion: number; attempt: number; maxAttempts: number;
  status: "queued" | "running" | "done" | "failed" | "waiting_for_coach" | "cancelled";
  leaseOwner: string | null; leaseUntil: number | null; heartbeatAt: number | null;
  stage: StageKey | null; remarkId: string | null;
};
type ClaimResponse = {
  job: JobWire; config: PipelineConfig; jobToken: string; timeoutS: number;
};
type WorkerJobResponse = {
  job: JobWire; config: PipelineConfig;
  session: {
    subject: Subject | null;
    subjectAnchor: {box: Box; frameMs: number; referenceCropKey: string} | null;
    renderMode: "video" | "stills"; durationMs: number | null;
  };
  inputs: {
    uploadId: string; sourceKey: string; declaredBytes: number;
    declaredSha256: string; mimeType: string;
    transcriptTurns: {
      turnId: string; startMs: number; endMs: number; speaker: string;
      text: string; correctedText: string | null;
    }[];
    remarks: {
      remarkId: string; turnIds: string[]; source: "voice" | "typed";
      aboutSubject: "yes" | "no" | "unclear" | "general";
      kind: "feedback" | "instruction" | "praise" | "other";
      atMs: number; mode: "tracked" | "still_frame" | "note_only";
      momentStartMs: number | null; momentEndMs: number | null;
      keyframeMs: number | null; momentWhy: string | null;
      status: "pending" | "ok" | "player_missing" | "needs_coach";
      includeInShare: boolean;
    }[];
    completedStageRuns: {
      jobId: string; stageRunId: string; idempotencyKey: string;
      stage: StageKey; remarkId: string | null; inputHash: string; outputRef: string;
    }[];
  };
};
```

`StageKey`, `Subject`, and `Box` use the existing contracts (§7 and generated types). Worker job reads require a completed upload and return its actual source metadata. Missing tap/anchor/duration remain null, not invented measurements. Completed artifact references require `status=done` and canonical output keys. Current-job artifacts are returned; for `subject_retrack`, earlier jobs in the same session additionally contribute completed `transcode`, `transcribe`, `plan`, and `moment` prerequisites. Consumers select by stage/remark/idempotency identity; absence stays absent (the missing-retrack-prerequisites question in SPEC remains unresolved). Coach words and remarks are existing database projections, never generated fallback content.

## Routes and state behavior

- `POST /svc/jobs/claim` `{leaseOwner}` → `ClaimResponse` or 204. Both `svc.claim` and foundation `jobs.claim` call the same helper. Serializable indexed reads prevent concurrent winners. Uses the job's pinned version, attempt limit and lease. Global daily spend sums all ledger rows for the actual ISO Singapore date (`UTC+8`), irrespective of coach. At/above the pinned daily cap returns 204 without claiming. Reclaim clears old error/ended fields.
- Timeout: `min(pinned sandboxTimeoutCapS, 600 + 180*ceil(durationMs/60000))`; finalize uses `300 + 60*ceil(...)`. If measured duration is absent, only timeout budgeting uses pinned `maxVideoMinutes`; source duration remains null. Disabled/empty enabled-stage selections do not affect timeout.
- `POST /svc/jobs/sandbox` `{jobId,sandboxId,sandboxName,driver:"local"|"modal"}` → `{ok:true}`. Registration requires a running job/live lease. Exact registration is a no-op, including after release; conflicting identity or an unreleased prior sandbox rejects. After the prior row is released a later job attempt can register a different sandbox. Registering an old exact identity never reopens it or changes the later job sandbox.
- `POST /svc/jobs/released` `{jobId,sandboxId,terminatedBy,exitCode?}` → `{ok:true}`. `terminatedBy` is `orchestrator|sweeper|timeout|self`; `exitCode` is integer or null (unknown). Null/omitted is stored as absent because the existing schema uses optional number. Release changes only the matching sandbox row. Exact release is immutable/idempotent, including timestamps; conflicting reason/code rejects. Releasing an old row never changes the job's newer sandbox.
- `POST /svc/jobs/fail` `{jobId,errorCode}` → `{ok:true}`. Running job → failed with ended time and cleared lease; changes session only if that job is still latest. Already-terminal jobs/sessions are preserved.
- `GET /svc/jobs/stale` → existing running job rows with expired lease or heartbeat at/before `now - HEARTBEAT_STALE_S*1000`; default 90. Nonfinite/nonpositive environment values fail closed with 503. `GET /svc/sandboxes/open` → existing sandbox rows with absent `terminatedAt`. These authenticated service lists intentionally return database rows (including lifecycle/termination metadata), not worker contract objects.
- `GET /worker/job` → `WorkerJobResponse`. `POST /worker/heartbeat` `{}` → `{ok:true}`; extends the live lease using the pinned config.
- `POST /worker/stageRuns/start` `{stage,workerId,attempt,idempotencyKey,inputHash,remarkId?,promptHash?,candidate?}` → `{stageRunId}`. Checks pinned enabled worker, hashes, remark membership, candidate, sequential attempts and retry cap. Exact starts reuse the row; changed prompt/candidate/input metadata conflicts.
- `POST /worker/stageRuns/finish` `{stageRunId,status,samFrames,inputTokens,outputTokens,costUsd,outputRef?,errorCode?}` → `{ok:true}`. Only terminal stage statuses; done requires outputRef. Run must belong to the authorized job/session/coach. Keys must be canonical `sessions/{sessionId}/...`: no dot traversal, empty segments, backslashes, percent encodings, queries or external URLs. Raw error detail is rejected. Usage/refs/status are persisted immutably; same replay does not change ended time or double-count usage (including paid failed attempts). Ledger write endpoints remain outside this slice.
- `POST /worker/done` `{status:"waiting_for_coach"|"failed"|"done",errorCode?}` → `{ok:true}`. Failed → session failed. Otherwise actionable errors → needs_you; no error → review_ready. `RENDER_FAIL` keeps review_ready for §15 live-overlay fallback. `SUBJECT_NEEDED` alone stamps subjectStatus anchor_failed; per-remark SUBJECT_NOT_FOUND/SUBJECT_SWAP do not erase a valid anchor. Terminal retries must match both status and optional error exactly and do not alter timestamps, cost, session or status. Conflicts reject; other terminal reads/writes reject.

No `/worker/persist/*` or `/worker/cost` route is registered. No live deployment, M1 E2E, persistence or vendor capability is claimed.

## Verification

Final command results are recorded below after the full repository checks and actual secret hooks run. Route tests inspect database rows, not only HTTP status. Token tests independently construct HMAC signatures from raw UTF-8 JSON. T1.31 E2E is not present in package scripts yet.

- `pnpm check`: PASS — ESLint, both strict TypeScript projects; **173 JS tests in 10 files**; Ruff; mypy **41 runner + 2 orchestrator source files**; **95 runner + 1 orchestrator Python tests**; **34 contracts verified**; **6 model-output schemas** pass structural limits; offline Convex bindings verified.
- `pnpm exec vitest run convex/tests/http-lifecycle.test.ts`: **64 passed**, including successful nonzero usage and repeated finish, all route authorization/state cases, transition tables, SGT rollover, streamed size limit, sandbox row contents and retrack inputs. `token.test.ts`: **11 passed**, including independent HMAC construction and noncanonical encoding rejection. The other foundation Convex tests contribute 21 cases.
- `pnpm contracts:gen` and `pnpm convex:codegen`: PASS. Only the expected jobs/stageRuns source digests changed in the contract manifest; schema and generated interface contents are unchanged.
- `scripts/secret-scan.sh`: PASS — real gitleaks history and working-tree scans; installed with the repository installer under ignored `.orca-scratch/tools`. `git diff --check`: PASS.
- `uv tool run --from pre-commit==4.7.0 pre-commit run --all-files`: PASS — real staged gitleaks hook. Commit-hook result and final HEAD are recorded in PR #5 after committing. T1.31 E2E is not implemented; no E2E or live-service success is claimed.
