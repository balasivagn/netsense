# L4 worker signing handoff — T1.05 partial

`POST /api/worker/sign` is now wired to `createWorkerSignHandler` in
`apps/web/lib/worker-sign.ts`. It verifies the raw-payload HMAC worker token with
`WORKER_TOKEN_SECRET`, then performs a fresh bounded, no-redirect `GET
${CONVEX_SITE_URL}/worker/job` for every request. The returned current job must
match the verified job/session claims, be `running`, and have a live lease.

The closed request accepts at most 32 operations and a 32 KiB streamed JSON body.
All keys must be canonical descendants of the token session. It returns the stable
request-ordered `{urls:[{op,key,url,expiresAt}]}` projection only after every
operation validates. GET has no content type; PUT has a safe nonempty content type.
TTL defaults to 600 seconds and is capped by the token and lease; less than one
full second fails closed. Responses are `Cache-Control: no-store` and errors expose
only fixed codes.

The real route gets the configured `VideoStorage`, so local signed URLs use the
existing local adapter. R2 signing and live Convex/R2 operation remain **UNTESTED**;
no storage credentials are passed to the worker.

T1.05 remains partial: this is the local worker-signing slice only. Coach media
signing and the R2 adapter remain pending in their assigned lanes.
