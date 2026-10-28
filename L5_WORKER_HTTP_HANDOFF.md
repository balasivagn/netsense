# L5 worker HTTP client handoff — T1.09/T1.10 partial

Branch: `lane/l5-worker-http-client`, based on reviewed persistence head `17d24d6` (PR11). This slice adds only `runner/netsense_runner/clients/` and its synthetic local HTTP tests. It makes no live Convex, vendor, or paid API calls.

## Callable API

`ConvexWorkerClient(runtime_site_url, job_token, timeout_s=20.0, max_response_bytes=32768)` accepts only an HTTP(S) origin without credentials, path, query, or fragment. The token is retained only for the Authorization header and is omitted from repr and fixed client errors.

- `get_job() -> WorkerJobResponse`: closed projection of the pinned job/config, session (including `studentLabel` and `subjectRole`), upload, turns, remarks, and completed runs.
- `heartbeat()`, `start_stage(...) -> stageRunId`, `finish_stage(...)`, `done(...)`.
- `persist_transcode`, `persist_turns`, `persist_plan`, `persist_moment`, `persist_target` (anchor or per-remark subject output), `persist_track(cache_key=...)`, `persist_marks(provenance=...) -> {markId: annotationId}`, `persist_verdicts`, and `persist_render`.

All persistence inputs are generated Pydantic outputs and are revalidated against the authoritative JSON Schema before transport. Optional request fields are omitted rather than sent as null. Marks validates the returned stable map exactly against the supplied mark IDs.

## Transport and failures

Each call uses independent standard-library transport, so heartbeats can run while another request is in flight. There are no retries or arbitrary route/URL overrides. Redirects are rejected. A monotonic deadline covers connect and streamed response reads; the response cap is 32,768 bytes (or the lower supplied limit). Failures are fixed codes only: `INVALID_ORIGIN`, `INVALID_TIMEOUT`, `CONTRACT_INVALID`, `HTTP_STATUS`, `TRANSPORT_FAILED`, `TIMEOUT`, `RESPONSE_TOO_LARGE`, `INVALID_RESPONSE`, and `REDIRECT_REJECTED`.

## DAG integration shape

The future DAG adapter creates the client from its supplied runtime origin and job token, calls `get_job()`, starts a stage, validates/runs its worker, invokes that stage's matching `persist_*`, then calls `finish_stage()`. The runner owns retry/idempotency decisions and calls `done()` only at terminal completion. It must pass no secret through logs.

`StageContext.WorkerApi`, generic `persist_stage_output`, usage/cost reporting, `/worker/cost`, next-focus, agent traces, and final approved-snapshot render integration are deliberately not adapted here. Live Convex and full M1 E2E remain **UNTESTED**.

## Verification

`cd runner && uv run pytest tests/test_worker_http.py` — 12 passed. Tests use ephemeral local ports/tokens and synthetic fixtures only; they cover the full registered endpoint set, projection/response mapping, omission semantics, pre-network contract rejection, status/malformed failures, limits, slow streamed timeout, redirect rejection, and independent heartbeat concurrency.
