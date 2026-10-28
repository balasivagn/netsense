import { auth } from "@clerk/nextjs/server";
import type { ReactNode } from "react";
import { CoachProvisioningGate } from "../providers";

export const dynamic = "force-dynamic";

export default async function SessionsLayout({
  children,
}: {
  children: ReactNode;
}) {
  if (
    !process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||
    !process.env.CLERK_SECRET_KEY ||
    !process.env.NEXT_PUBLIC_CONVEX_URL
  ) {
    return (
      <main className="auth-state" role="alert">
        Coach sign-in is not configured.
      </main>
    );
  }

  const { userId, redirectToSignIn } = await auth();
  if (!userId) return redirectToSignIn();

  return <CoachProvisioningGate>{children}</CoachProvisioningGate>;
}
