import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
export async function requireCoach(ctx: QueryCtx): Promise<Doc<"coaches">> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("UNAUTHENTICATED");
  const coach = await ctx.db
    .query("coaches")
    .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", identity.subject))
    .unique();
  if (!coach) throw new Error("COACH_NOT_REGISTERED");
  return coach;
}
export async function ensureCoach(ctx: MutationCtx): Promise<Doc<"coaches">> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("UNAUTHENTICATED");
  const existing = await ctx.db
    .query("coaches")
    .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", identity.subject))
    .unique();
  if (existing) return existing;
  const id = await ctx.db.insert("coaches", {
    clerkUserId: identity.subject,
    displayName: identity.name ?? "",
    createdAt: Date.now(),
  });
  return (await ctx.db.get(id))!;
}
export async function ownedSession(ctx: QueryCtx, sessionId: Id<"sessions">) {
  const coach = await requireCoach(ctx);
  const session = await ctx.db.get(sessionId);
  if (!session || session.coachId !== coach._id) throw new Error("NOT_FOUND");
  return session;
}
