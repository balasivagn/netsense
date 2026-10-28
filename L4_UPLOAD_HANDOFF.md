# L4 local uploads handoff — T1.06 / T1.37 PARTIAL

Base: exact reviewed commit `6010050fc68515fcad57a93bff1cf57bfeb62468`.
Branch: `lane/l4-local-uploads`. No UI, runner, renderer or auth changes.

## Integration API

All five actual Next POST exports are implemented: `/api/uploads`,
`/[uploadId]/parts`, `/[uploadId]/parts/confirm`, `/[uploadId]/complete`, and
`/[uploadId]/abort`. Use the closed request/response shapes in SPEC §10.2.
Abort and complete require `{}`; `complete.jobId` is nullable while awaiting a tap.
Init returns `resumeFrom` as confirmed part numbers, never optimistic progress.
The existing `sessions.confirmConsent` must precede init. Native Clerk Convex
integration and legacy JWT-template selection remain in `getCoachRouteAuth`.

Configure the existing env names: `NEXT_PUBLIC_CONVEX_URL`, `CONVEX_SITE_URL`,
`CONVEX_SERVICE_SECRET`, explicit `STORAGE_DRIVER=local`, `LOCAL_STORAGE_DIR`,
`MEDIA_URL_SIGNING_SECRET`, and optionally `APP_BASE_URL`. Values stay out of source.

The authenticated owner-only `uploads.owned` query supplies authoritative identity.
Next alone inspects disk and calls the service-secret-authenticated private
`/svc/uploads/{reserve,confirm,begin,complete,abort}` bridge. These call internal
mutations; browser bodies cannot supply privileged identities or measurements.
Exact private wires, body/response bounds, deadlines, errors and retry semantics
are documented in SPEC §10.2. No route logs request bodies, identities or URLs.

## State and storage changes

- Optional upload `confirmedParts:[{partNumber,etag,bytes}]` and
  `phase:"completing"|"aborting"`; existing status enum is unchanged.
- New reservations store a server UUID before storage creation. Concurrent init
  and response-loss retries reuse that UUID. One source identity per session;
  different SHA/size/MIME is rejected. Stopped uploads never reopen.
- Local `initMultipart` accepts an optional reserved UUID. `inspectPart` supplies
  actual bytes and SHA-256 ETag under the local lock. Multipart PUTs are immutable
  from first write and capped at 8 MiB. Source keys are canonical and session-scoped.
- Confirm checks exact actual bytes/ETag and expected part length; duplicates do
  not inflate progress. Complete checks actual HEAD before enqueueing. SHA-256
  of the whole clip remains the later transcode stage's responsibility.
- First transactional completing/aborting reservation wins. Same-operation retries
  recover disk success followed by DB/response failure. Assembly can recover an
  existing byte-identical object after an interrupted metadata write. Abort keeps
  a terminal storage tombstone, covering delayed init without orphaning parts.
- Existing `enqueueReady` serializes completion and subject selection: both tap
  orders enqueue one pipeline job. No processing before the tap was added.
- Generated contract manifest refreshed with `pnpm contracts:gen`.
  `pnpm convex:codegen` ran; module bindings needed no diff.

## Acceptance evidence

`pnpm exec vitest run apps/web/lib/upload/handler.test.ts`: **10 passed**.
These invoke the actual Next route exports, dispatch authenticated queries into
real convex-test functions, use real Convex HTTP actions and real local storage.
Clerk auth and ConvexHttpClient transport are test seams; this is not browser E2E.
Coverage includes every route's unauthenticated and non-owner rejection, consent
with storage never called, malformed/oversized/stalled bodies, SHA resume and
reload progress, concurrent init/confirm/complete retries, missing/wrong parts,
immutable PUT retries, a multi-part final remainder, actual final disk-size
mismatch, private bridge authorization, response loss, delayed init versus abort,
both tap orders and exactly-once enqueue. R2 fails closed.

- `pnpm check`: PASS — lint, strict TypeScript, **327 JS tests**, Python lint/typechecks,
  **383 runner tests**, **33 orchestrator tests**, **34 contract** drift checks,
  six model-output schema structural checks, offline Convex bindings.
- `pnpm --filter @netsense/web build`: PASS — optimized production build,
  route type validation and static generation; all five upload routes listed.
- `pnpm contracts:gen` and `pnpm convex:codegen`: PASS (manifest refreshed).
- `scripts/secret-scan.sh`: PASS — history and working source, no leaks.
  Installed the pinned checksum-verified gitleaks via `scripts/install-gitleaks.sh`.
- `git diff --check`: PASS.
- `git hook run pre-commit`: PASS — actual staged gitleaks hook.
  The commit also runs the installed hook; no bypass is used.

No `pnpm e2e` command exists in this base; no browser E2E was run.

## Remaining limits

T1.06/T1.37 remain **PARTIAL**: consent checkbox/progress UI and Playwright
integration are outside this slice. There is no `pnpm e2e` script yet; no full M1
E2E or real Clerk login/deployment test is claimed. R2/live vendor behavior is
**UNTESTED** and unavailable. No real footage or credentials were used.

Local locks assume SPEC's single web process; multiple processes sharing a local
storage directory are unsupported. A completing reservation wins against a later
abort and must be retried after transient failure; disk corruption requires
operator repair. Legacy uploads missing reservation/confirmed metadata are not
silently migrated into the new local route flow. Completed local multipart parts
remain on disk with the source until session deletion. Selection-frame fallback,
transcode, anchor and tracking remain later work.

## Parent review

Parent validation replaces the mocked ConvexHttpClient with the actual client and
its bounded transport. Only the network boundary dispatches in-process to the
real Convex test queries/actions; Clerk remains a test seam. Added query/service
oversized and stalled response tests with stream cancellation, two completion
requests overlapping before disk completion, and abort winning while disk cleanup
is still running. The public HTTP table in SPEC is kept contiguous.

`pnpm exec vitest run apps/web/lib/upload/handler.test.ts`: **16 passed**.
`pnpm check`: **333 JS, 383 runner, 33 orchestrator tests passed**, including
lint, strict typechecks, contracts and offline bindings. This remains local test
evidence, not live Clerk/Convex or browser E2E.
