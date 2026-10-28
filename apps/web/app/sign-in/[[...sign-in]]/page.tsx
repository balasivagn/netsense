import { SignIn } from "@clerk/nextjs";

export const dynamic = "force-dynamic";

function SignInUnavailable() {
  return (
    <main className="sign-in" aria-labelledby="coach-sign-in-title">
      <p className="sign-in__brand">NetSense</p>
      <h1 id="coach-sign-in-title">Coach sign-in</h1>
      <p className="sign-in__offline" role="alert">
        No connection, try again
      </p>
      <p className="sign-in__notice">
        <strong>Coaches only.</strong> Students never sign in. They open a
        private link you send.
      </p>
    </main>
  );
}

export default function SignInPage() {
  if (
    !process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||
    !process.env.NEXT_PUBLIC_CONVEX_URL
  ) {
    return <SignInUnavailable />;
  }

  return (
    <main className="sign-in" aria-labelledby="coach-sign-in-title">
      <p className="sign-in__brand">NetSense</p>
      <h1 id="coach-sign-in-title">Coach sign-in</h1>
      <p>
        Turn what you say at the nets into marked video your students can
        revisit. You review everything before it’s shared.
      </p>
      <SignIn fallbackRedirectUrl="/sessions" />
      <p className="sign-in__notice">
        <strong>Coaches only.</strong> Students never sign in. They open a
        private link you send.
      </p>
    </main>
  );
}
