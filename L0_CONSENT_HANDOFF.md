# L0 consent-contract handoff — partial T1.37 foundation

Branch: `lane/l0-consent-contract`. This amendment extends the frozen L0 candidate after Bala's consent decision in `9fcd649`. It is **partial T1.37 only**: no screen, HTTP upload guard, storage call, upload lifecycle change, or Playwright coverage is included here.

## Contract delivered

- `sessions.consentConfirmedAt?: number` and `sessions.consentConfirmedBy?: string` are optional so existing sessions remain unconfirmed until explicitly confirmed.
- Public `sessions.confirmConsent({sessionId})` accepts only the session ID. An authenticated, registered owner can make the first confirmation; it atomically stores server `Date.now()` and the authenticated Clerk `identity.subject`. Repeated and concurrent calls preserve the original pair. It has no unconfirm path and creates neither a `consents` table nor per-person records.
- `CONSENT_REQUIRED` is in the ErrorCode JSON Schema and its generated TypeScript, Python, bundled-schema, manifest, and Convex validator outputs.

## Mandatory upload/UI integration

The upload/UI lane must implement the remaining T1.37 acceptance criteria before T1.37 can be marked complete:

1. Screen 06 must show the exact, initially unticked checkbox text: “Everyone filmed in this clip is an adult and agreed to be filmed.” Camera selection, file selection, and upload must remain unavailable until it is checked and `sessions.confirmConsent` succeeds.
2. `POST /api/uploads` must read persisted session consent server-side. When `consentConfirmedAt` is absent, it must return `409 CONSENT_REQUIRED` **before any storage or multipart operation**. A stale tab must return the screen-06 checkbox to its unticked state with the specified error copy.
3. Add route and Playwright coverage proving the guard makes no storage call and the controls remain disabled until confirmation. Do not add an unconfirm action, per-person records, or a junior-consent flow.

The record mutation is not an upload authorization substitute: the HTTP route must enforce this persisted-state check independently.
