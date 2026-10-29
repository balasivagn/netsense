# L5 runner interface handoff — T1.08

Base dependency: `030c86bee4beba89f0a2e494abf143483454eb83` from
`origin/lane/l0-contracts-foundation` (PR #1). This lane is a candidate for
parent review; it does not claim that foundation is merged.

## Delivered boundary

- `stage.py` defines the strict `StageWorker` protocol, stage keys/types, result
  status, usage and trace values. `context.py` is a frozen `StageContext` with
  explicit minimal `WorkerStorage`, `WorkerApi`, and scrubbed structured logger
  protocols. T1.10 owns the concrete worker HTTP wire implementation.
- `ProviderRegistry` snapshots its provider mapping. Jobs must select from the
  pinned pipeline config; this code has no environment-based running-job
  override.
- `Budget` uses a lock for job SAM/token counters and spend reservations. Its
  `DailySpendLedger` protocol must be backed by an atomic service-side ledger by
  the orchestrator lane. Cache hits make no reservation and therefore cannot
  double charge.
- `AgentAdapter` bundles JSON-schema references, supports per-call enum
  specialization, sends strict `response_format`, encodes images only as data
  URLs, and validates returned JSON against the exact specialized schema as well
  as `validate_contract`. Integer and string enums can only narrow the source
  schema. Transport errors are reduced to safe codes. Chat text uses `text`,
  with an optional system preamble and the specified temperature.
- `ModelApiAdapter` is a transport-injected shape for non-chat transcription and
  response streaming. Meta endpoint behavior remains **UNTESTED**; there are no
  live calls. `ToolAdapter` releases its process group in `finally`, including
  cancellation, and replaces arbitrary stderr with a fixed redaction marker.
  `RulesAdapter` is pure. Budget counters reject invalid/non-finite usage and
  keep a private copy of the pinned limits.
- The fake provider serves only files below `fixtures/synthetic/adapters`, needs
  an explicit non-production `NETSENSE_ENV`, and rejects blank or production-like
  values including case variants. Its constructor cannot override a production
  environment, and fixture symlinks cannot escape their synthetic directory.
  Gemini remains a `NotConfigured` stub (G1 pending).

## Parent integration notes

T1.09 should perform the pre/post `validate_contract` stage boundary, construct
the `StageContext` with job-pinned IDs/config, and persist `StageResult` via the
T1.10 worker API. It must provide an atomic `DailySpendLedger` implementation;
this lane intentionally does not guess its service API. Do not log raw adapter
responses, storage URLs, or transcript content.

## Verification

Focused: `cd runner && uv run ruff check . && uv run mypy --strict
netsense_runner tests && uv run pytest -q tests/test_adapters.py
tests/test_budget_registry.py` — 29 passed after parent review fixes. Full runner and repository checks
are recorded in the lane PR.
