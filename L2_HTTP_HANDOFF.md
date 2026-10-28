# L2 HTTP lifecycle handoff

This bounded T1.10 slice adds authenticated `/svc/*` lifecycle routes and `/worker/*` job, heartbeat, and stage-run routes. It does **not** register any persistence routes; transcript/annotation persistence remains a separate, pending slice.

`CONVEX_SERVICE_SECRET` is required for every `/svc/*` request. `WORKER_TOKEN_SECRET` is required before a job can be claimed. Both remain environment-only runtime values.

Job tokens are two base64url segments: `base64url(payload).base64url(signature)`. `payload` is the raw UTF-8 JSON bytes of exactly `{jobId,sessionId,exp}` and `signature` is `HMAC-SHA256(WORKER_TOKEN_SECRET, raw UTF-8 JSON payload)`. `exp` is epoch milliseconds. The encoded payload segment is not the signing input. Tokens are never logged.

The worker wire response has pinned `config`, job/session identifiers, the source upload fields `uploadId`, `sourceKey`, `declaredBytes`, `declaredSha256`, `mimeType`, session subject/render fields, transcript turns, remarks, and completed stage-run references. A completed stage-run reference explicitly has `jobId`, `stageRunId`, `idempotencyKey`, `stage`, `remarkId`, `inputHash`, and `outputRef`; absent artifacts are not fabricated.

All external behavior is UNTESTED against a deployed Convex instance. Route tests use the real Convex in-memory HTTP router and mutation path only.
