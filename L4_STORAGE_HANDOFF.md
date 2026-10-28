# L4 local storage handoff — partial T1.05

Base dependency: foundation candidate `030c86bee4beba89f0a2e494abf143483454eb83` (PR #1). It is not merged or deployed.

## Delivered

- `VideoStorage` is frozen exactly as SPEC §12 defines it.
- `LocalVideoStorage` stores only `sessions/...` keys under `LOCAL_STORAGE_DIR`, validates canonical key components, rejects percent-encoded paths and symlink escapes, and uses per-upload part directories.
- Multipart part URLs bind the HTTP method, object key, expiry, content type, upload ID and part number with HMAC. Completion re-hashes durable part files, assembles by streaming, atomically creates the final object without overwrite, and supports safe retry after completion.
- The local route verifies signatures before streaming PUT/GET. GET has single-range (exact, suffix and open-ended) support. It streams from disk and never buffers the complete object.
- Direct PUT atomically replaces a derivative, matching object storage semantics needed for worker retries and final re-renders. GET snapshots an open file descriptor, byte length and content type under the mutation lock, so replacing the object cannot change an in-flight response. Multipart parts and completion manifests remain immutable.
- Parent review added immutable parts (identical retries only), exact completion-manifest replay, and per-session mutation serialization shared by adapter instances in the one web process defined in SPEC §5. A multi-process server sharing one local directory is not supported; production uses R2 per the latest S1 decision. Empty-object and 416 headers, direct-PUT content type, and exact expiry-boundary checks are covered by regression tests.
- `getVideoStorage` requires an explicit `STORAGE_DRIVER=local` plus both local-storage settings. `r2` fails explicitly: it is not silently substituted with local storage.

## Pending integration (do not add unauthenticated wrappers)

- L2/L3 must supply authenticated coach/session/job-state lookups before implementing `/api/media/sign` and `/api/worker/sign`. Worker signing must authorize `sessions/{sessionId}/` from the verified job token; coach signing must authorize the requested session asset. Both should use this adapter's `signGetUrl`/`signPutUrl` or `signPartUrls` only after that check.
- Upload APIs must persist the returned upload ID, call `signPartUrls`, retain server-confirmed ETags, and call `head` after `completeMultipart`; client-supplied ETags and byte counts are insufficient.
- R2 remains **UNTESTED** and unimplemented in this partial lane. No R2 credentials or calls were added.

Parent focused verification: `pnpm exec vitest run apps/web/lib/storage/local.test.ts` — 11 tests passed, including concurrent completion, abort during an active PUT, and replacement while a GET remains open. Strict TypeScript checks passed. The PR carries the full check and secret-scan results.
