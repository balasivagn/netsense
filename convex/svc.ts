import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { errorCode } from "./errorCodes";

const sgtDay = (now: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Singapore", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date(now))
    .filter((part) => part.type !== "literal")
    .map((part) => part.value)
    .join("-");

export const claim = internalMutation({
  args: { leaseOwner: v.string() },
  handler: async (ctx, { leaseOwner }) => {
    if (!leaseOwner.trim() || leaseOwner.length > 160) throw Error("CONTRACT_INVALID");
    const now = Date.now();
    const queued = await ctx.db.query("jobs").withIndex("by_status_createdAt", (q) => q.eq("status", "queued")).order("asc").collect();
    const job = queued.find((item) => item.attempt < item.maxAttempts);
    if (!job) return null;
    const config = await ctx.db.query("pipeline_config").withIndex("by_version", (q) => q.eq("version", job.configVersion)).unique();
    if (!config) throw Error("CONFIG_MISSING");
    const today = sgtDay(now);
    const ledger = await ctx.db.query("costLedger").withIndex("by_day", (q) => q.eq("day", today)).collect();
    if (ledger.reduce((sum, row) => sum + row.usd, 0) >= config.limits.dailySpendLimitUsd) return null;
    const leaseUntil = now + config.limits.jobLeaseS * 1000;
    await ctx.db.patch(job._id, { status: "running", leaseOwner, leaseUntil, heartbeatAt: now, startedAt: job.startedAt ?? now, attempt: job.attempt + 1 });
    return { jobId: job._id, sessionId: job.sessionId, config, timeoutS: Math.min(config.limits.sandboxTimeoutCapS, Math.max(1, Math.ceil(Math.max(...config.stages.filter((stage) => stage.enabled).map((stage) => stage.timeoutMs)) / 1000))) };
  },
});

export const sandbox = internalMutation({
  args: { jobId: v.id("jobs"), sandboxId: v.string(), sandboxName: v.string(), driver: v.union(v.literal("local"), v.literal("modal")) },
  handler: async (ctx, args) => {
    if (!args.sandboxId.trim() || !args.sandboxName.trim()) throw Error("CONTRACT_INVALID");
    const job = await ctx.db.get(args.jobId);
    if (!job || job.status !== "running") throw Error("JOB_NOT_RUNNING");
    const existing = await ctx.db.query("sandboxes").withIndex("by_jobId", (q) => q.eq("jobId", args.jobId)).collect();
    if (existing.length) {
      if (existing.length === 1 && existing[0].sandboxId === args.sandboxId && existing[0].sandboxName === args.sandboxName && existing[0].driver === args.driver) return;
      throw Error("SANDBOX_CONFLICT");
    }
    await ctx.db.insert("sandboxes", { coachId: job.coachId, jobId: job._id, sandboxId: args.sandboxId, sandboxName: args.sandboxName, driver: args.driver, createdAt: Date.now() });
    await ctx.db.patch(job._id, { sandboxId: args.sandboxId, sandboxName: args.sandboxName });
  },
});

export const released = internalMutation({
  args: { jobId: v.id("jobs"), sandboxId: v.string(), terminatedBy: v.union(v.literal("orchestrator"), v.literal("sweeper"), v.literal("timeout"), v.literal("self")), exitCode: v.optional(v.union(v.number(), v.null())) },
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("sandboxes").withIndex("by_jobId", (q) => q.eq("jobId", args.jobId)).collect();
    const sandbox = rows.find((row) => row.sandboxId === args.sandboxId);
    if (!sandbox) throw Error("SANDBOX_NOT_FOUND");
    if (sandbox.terminatedAt !== undefined) {
      if (sandbox.terminatedBy === args.terminatedBy && sandbox.exitCode === (args.exitCode ?? undefined)) return;
      throw Error("SANDBOX_IMMUTABLE");
    }
    await ctx.db.patch(sandbox._id, { terminatedAt: Date.now(), terminatedBy: args.terminatedBy, ...(args.exitCode === null || args.exitCode === undefined ? {} : { exitCode: args.exitCode }) });
  },
});

export const fail = internalMutation({
  args: { jobId: v.id("jobs"), errorCode },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) throw Error("NOT_FOUND");
    if (job.status !== "running") return;
    await ctx.db.patch(job._id, { status: "failed", errorCode: args.errorCode, endedAt: Date.now() });
    await ctx.db.patch(job.sessionId, { status: "failed" });
  },
});

export const stale = internalQuery({
  args: { staleSeconds: v.number() },
  handler: async (ctx, { staleSeconds }) => {
    const now = Date.now();
    return ctx.db.query("jobs").withIndex("by_status_createdAt", (q) => q.eq("status", "running")).collect().then((jobs) => jobs.filter((job) => (job.leaseUntil ?? 0) <= now || (job.heartbeatAt ?? 0) <= now - staleSeconds * 1000));
  },
});

export const openSandboxes = internalQuery({
  args: {},
  handler: (ctx) => ctx.db.query("sandboxes").withIndex("by_terminatedAt", (q) => q.eq("terminatedAt", undefined)).collect(),
});
