# L3 auth handoff (T1.04)

## What landed

- Next 16.4.3 `proxy.ts` protects `/sessions/**` and early-filters future coach browser APIs: `/api/uploads/**` and `/api/media/sign/**`.
- It intentionally does **not** protect `/api/worker/sign`, `/api/media/local/**`, `/l/**`, or `/api/l/**` because those use worker tokens, signed URLs, or student-link access instead.
- `app/sessions/layout.tsx` performs its own Clerk server check and only renders children after the Convex-authenticated identity has provisioned `coaches.ensure`.
- `AppProviders` uses `ClerkProvider`, `ConvexProviderWithClerk`, `useAuth`, and a `ConvexReactClient`. Bootstrap runs only after `useConvexAuth()` reports an authenticated Convex identity. It is one attempt per current user/session identity, fails closed, and starts fresh after an account change.
- `convex/auth.config.ts` configures Clerk’s issuer with the `convex` application ID. Existing Convex functions keep server-enforced coach ownership through `requireCoach`/`ownedSession`.

## Future coach route handlers

Do not rely on `proxy.ts`. Call `getCoachRouteAuth()` first and return an unauthenticated response if it is null. Pass its `convexToken` to the Convex client/request so the Convex ownership checks execute. Do not log the token or Clerk identity.

```ts
const coach = await getCoachRouteAuth();
if (!coach) return new Response(null, { status: 401 });
// Create the authenticated Convex request with coach.convexToken.
```

## Required configuration / validation

SETUP steps 2–3 must supply `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `CLERK_JWT_ISSUER_DOMAIN`, and `NEXT_PUBLIC_CONVEX_URL`; set the issuer on the Convex deployment and activate Clerk’s Convex integration (or a JWT template named `convex`). Configure Google and Email code in the Clerk dashboard. Do not add values to source control.

Official references: [Convex + Clerk](https://docs.convex.dev/auth/clerk), [Convex auth config](https://docs.convex.dev/config/auth.config.ts), [Clerk Next.js auth](https://clerk.com/docs/reference/nextjs/app-router/auth), [Clerk route handlers](https://clerk.com/docs/reference/nextjs/app-router/route-handlers).

Real Clerk browser E2E is **UNTESTED** until those credentials and a Clerk testing-token setup are available.
