# L2 worker/service API handoff — T1.10 (partial)

Base dependency: `030c86bee4beba89f0a2e494abf143483454eb83` from PR #1. It is not asserted merged.

## Authentication and errors

- `/svc/*` requires `Authorization: Bearer <CONVEX_SERVICE_SECRET>`. An unset secret is a `401 {"error":"UNAUTHORIZED"}`.
- `/worker/*` requires an HMAC-SHA256 token made by `signJobToken`: `base64url(JSON payload).base64url(signature)`, payload `{jobId,sessionId,exp}`. `verifyJobToken` uses Web Crypto and rejects malformed, modified and expired tokens. A valid signature is insufficient: each internal worker mutation rechecks that the job belongs to that session, is `running`, and has an unexpired lease in the same transaction as its write.
- Responses are JSON. Success mutations return `{ "ok": true }`; malformed body is `400 {"error":"CONTRACT_INVALID"}`; failed worker authorization/state is `401 {"error":"WORKER_REJECTED"}`. Error bodies never include tokens, source text, or database identifiers beyond caller-supplied values.

## Service routes

- `POST /svc/jobs/claim` body `{leaseOwner:string}` returns a claimed job object or an empty `204` response.
- `POST /svc/jobs/sandbox`, `/released`, `/fail` forward their SPEC request shapes and return `{ok:true}`; sandbox release is idempotent.
- `GET /svc/jobs/stale?heartbeatStaleMs=<non-negative integer>` returns `Job[]`; `/svc/sandboxes/open` returns `Sandbox[]`.

## Worker routes currently exposed

- `GET /worker/job` returns `{job,config,session,inputs}`. All absent Convex optionals are explicit `null` (`subject`, `subjectAnchor`, `durationMs`), while a completed run has `{stage,remarkId:null|id,outputRef}`. It deliberately excludes coach/student records, secrets, and signed URLs.
- `POST /worker/heartbeat`, `/stageRuns/start`, `/stageRuns/finish`, and persist `turns`, `plan`, `moment`, `target`, `track`, `marks`, `verdicts`, plus `/done` are routed.
- Turn persistence is immutable; plan verifies unique session turn ids and derives timing; marks copy label spans from transcript text with surrogate/word-boundary and 60 UTF-16 unit checks. Notes about another person/general are rejected for marks; AI marks remain `needs_you` and never overwrite coach-approved/deleted marks.

## Explicit high-risk gaps for the parent/L5

This lane is **not ready for runner integration**: `/worker/persist/render`, `/nextFocus`, and `/cost` are not implemented; no `pipeline.ts` adapter exists; stage start/finish wire adaptation still needs route-specific schemas (the generic wrapper does not translate the token's session id for those pre-existing functions); provenance is not yet filled from pinned stage runs; and SGT daily-cost de-duplication is not implemented. Do not build a client against those assumed endpoints. The missing transcode/anchor artifact contract also remains unresolved: `/worker/job` only returns completed `outputRef`s, not fabricated artifact payloads.
