import { claimJob } from "./lib/lifecycle";
import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { errorCode } from "./errorCodes";

export const claim = internalMutation({
  args: { leaseOwner: v.string() },
  handler: (ctx, { leaseOwner }) => claimJob(ctx, leaseOwner),
});

export const sandbox = internalMutation({
  args: {
    jobId: v.id("jobs"),
    sandboxId: v.string(),
    sandboxName: v.string(),
    driver: v.union(v.literal("local"), v.literal("modal")),
  },
  handler: async (ctx, args) => {
    if (!args.sandboxId.trim() || !args.sandboxName.trim())
      throw Error("CONTRACT_INVALID");
    const job = await ctx.db.get(args.jobId);
    if (!job || job.status !== "running" || (job.leaseUntil ?? 0) <= Date.now())
      throw Error("JOB_NOT_RUNNING");
    const existing = await ctx.db
      .query("sandboxes")
      .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
      .collect();
    const same = existing.find((row) => row.sandboxId === args.sandboxId);
    if (same) {
      if (same.sandboxName === args.sandboxName && same.driver === args.driver)
        return;
      throw Error("SANDBOX_CONFLICT");
    }
    if (existing.some((row) => row.terminatedAt === undefined))
      throw Error("SANDBOX_CONFLICT");
    await ctx.db.insert("sandboxes", {
      coachId: job.coachId,
      jobId: job._id,
      sandboxId: args.sandboxId,
      sandboxName: args.sandboxName,
      driver: args.driver,
      createdAt: Date.now(),
    });
    await ctx.db.patch(job._id, {
      sandboxId: args.sandboxId,
      sandboxName: args.sandboxName,
    });
  },
});

export const released = internalMutation({
  args: {
    jobId: v.id("jobs"),
    sandboxId: v.string(),
    terminatedBy: v.union(
      v.literal("orchestrator"),
      v.literal("sweeper"),
      v.literal("timeout"),
      v.literal("self"),
    ),
    exitCode: v.optional(v.union(v.number(), v.null())),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("sandboxes")
      .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
      .collect();
    const sandbox = rows.find((row) => row.sandboxId === args.sandboxId);
    if (!sandbox) throw Error("SANDBOX_NOT_FOUND");
    if (sandbox.terminatedAt !== undefined) {
      if (
        sandbox.terminatedBy === args.terminatedBy &&
        sandbox.exitCode === (args.exitCode ?? undefined)
      )
        return;
      throw Error("SANDBOX_IMMUTABLE");
    }
    await ctx.db.patch(sandbox._id, {
      terminatedAt: Date.now(),
      terminatedBy: args.terminatedBy,
      ...(args.exitCode === null || args.exitCode === undefined
        ? {}
        : { exitCode: args.exitCode }),
    });
  },
});

export const fail = internalMutation({
  args: { jobId: v.id("jobs"), errorCode },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) throw Error("NOT_FOUND");
    if (job.status !== "running") return;
    await ctx.db.patch(job._id, {
      status: "failed",
      errorCode: args.errorCode,
      endedAt: Date.now(),
      leaseUntil: undefined,
    });
    const session = await ctx.db.get(job.sessionId);
    if (session?.latestJobId === job._id)
      await ctx.db.patch(job.sessionId, { status: "failed" });
  },
});

export const stale = internalQuery({
  args: { staleSeconds: v.number() },
  handler: async (ctx, { staleSeconds }) => {
    if (!Number.isFinite(staleSeconds) || staleSeconds <= 0)
      throw Error("INVALID_STALE_SECONDS");
    const now = Date.now();
    return ctx.db
      .query("jobs")
      .withIndex("by_status_createdAt", (q) => q.eq("status", "running"))
      .collect()
      .then((jobs) =>
        jobs.filter(
          (job) =>
            (job.leaseUntil ?? 0) <= now ||
            (job.heartbeatAt ?? 0) <= now - staleSeconds * 1000,
        ),
      );
  },
});

export const openSandboxes = internalQuery({
  args: {},
  handler: (ctx) =>
    ctx.db
      .query("sandboxes")
      .withIndex("by_terminatedAt", (q) => q.eq("terminatedAt", undefined))
      .collect(),
});
