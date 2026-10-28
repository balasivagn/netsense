import { claimJob } from "./lib/lifecycle";
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id, Doc } from "./_generated/dataModel";
export async function enqueueJob(
  ctx: MutationCtx,
  session: Doc<"sessions">,
  kind: Doc<"jobs">["kind"],
  extra: { remarkId?: string; stage?: Doc<"jobs">["stage"] } = {},
) {
  const config = await ctx.db
    .query("pipeline_config")
    .withIndex("by_active", (q) => q.eq("active", true))
    .unique();
  if (!config) throw Error("CONFIG_MISSING");
  const id = await ctx.db.insert("jobs", {
    sessionId: session._id,
    coachId: session.coachId,
    kind,
    ...extra,
    configVersion: config.version,
    status: "queued",
    coachStage: config.coachStages[0],
    attempt: 0,
    maxAttempts: config.limits.jobMaxAttempts,
    samFrames: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    createdAt: Date.now(),
  });
  await ctx.db.patch(session._id, { latestJobId: id, status: "processing" });
  return id;
}
export async function enqueueReady(
  ctx: MutationCtx,
  sessionId: Id<"sessions">,
) {
  const session = await ctx.db.get(sessionId);
  if (!session) throw Error("NOT_FOUND");
  const jobs = await ctx.db
    .query("jobs")
    .withIndex("by_sessionId", (q) => q.eq("sessionId", sessionId))
    .collect();
  const existing = jobs.find((j) => j.kind === "pipeline");
  if (existing) return existing._id;
  if (!session.subject) return null;
  const uploads = await ctx.db
    .query("uploads")
    .withIndex("by_sessionId", (q) => q.eq("sessionId", sessionId))
    .collect();
  if (!uploads.some((u) => u.status === "complete")) return null;
  return enqueueJob(ctx, session, "pipeline");
}
export const enqueueWhenReady = internalMutation({
  args: { sessionId: v.id("sessions") },
  handler: (ctx, args) => enqueueReady(ctx, args.sessionId),
});
// Other job kinds are in the schema; their action-specific entry points belong to later lanes.
export const enqueue = internalMutation({
  args: { sessionId: v.id("sessions"), kind: v.literal("pipeline") },
  handler: (ctx, args) => enqueueReady(ctx, args.sessionId),
});
export const claim = internalMutation({
  args: { leaseOwner: v.string() },
  handler: async (ctx, args) =>
    (await claimJob(ctx, args.leaseOwner))?.job ?? null,
});
