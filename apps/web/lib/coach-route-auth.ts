import { auth } from "@clerk/nextjs/server";

/**
 * Use in every coach-only route handler before calling Convex. The proxy is
 * deliberately not the authorization boundary: handlers must reject null and
 * pass `convexToken` to Convex so its ownership checks run.
 */
export async function getCoachRouteAuth(): Promise<{
  clerkUserId: string;
  convexToken: string;
} | null> {
  const { userId, getToken, sessionClaims } = await auth();
  if (!userId) return null;

  // Match the installed ConvexProviderWithClerk: native integration tokens
  // already carry the convex audience; legacy setups use the named template.
  const convexToken = await getToken(
    sessionClaims?.aud === "convex" ? {} : { template: "convex" },
  );
  if (!convexToken) return null;

  return { clerkUserId: userId, convexToken };
}
