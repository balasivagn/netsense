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
  const { userId, getToken } = await auth();
  if (!userId) return null;

  const convexToken = await getToken({ template: "convex" });
  if (!convexToken) return null;

  return { clerkUserId: userId, convexToken };
}
