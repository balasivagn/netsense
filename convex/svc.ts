import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { errorCode } from "./errorCodes";
import { stage } from "./validators";

const running = (job: { status: string; leaseUntil?: number } | null) => job?.status === "running" && (job.leaseUntil ?? 0) >= Date.now();
export const heartbeat = internalMutation({ args: { jobId: v.id("jobs") }, handler: async (ctx, { jobId }) => {
  const job = await ctx.db.get(jobId); if (!running(job)) throw Error("JOB_NOT_RUNNING");
  const config = await ctx.db.query("pipeline_config").withIndex("by_version", q => q.eq("version", job!.configVersion)).unique();
  if (!config) throw Error("CONFIG_MISSING"); const now = Date.now();
  await ctx.db.patch(jobId, { heartbeatAt: now, leaseUntil: now + config.limits.jobLeaseS * 1000 });
}});
export const sandbox = internalMutation({ args: { jobId: v.id("jobs"), sandboxId: v.string(), sandboxName: v.string(), driver: v.union(v.literal("modal"), v.literal("local")) }, handler: async (ctx, args) => {
  const job = await ctx.db.get(args.jobId); if (!running(job) || !args.sandboxId || !args.sandboxName) throw Error("JOB_NOT_RUNNING");
  const existing = await ctx.db.query("sandboxes").withIndex("by_jobId", q => q.eq("jobId", args.jobId)).collect();
  if (existing.some(s => !s.terminatedAt && s.sandboxId !== args.sandboxId)) throw Error("SANDBOX_CONFLICT");
  if (!existing.some(s => s.sandboxId === args.sandboxId)) await ctx.db.insert("sandboxes", { coachId: job!.coachId, jobId: job!._id, sandboxId: args.sandboxId, sandboxName: args.sandboxName, driver: args.driver, createdAt: Date.now() });
  await ctx.db.patch(job!._id, { sandboxId: args.sandboxId, sandboxName: args.sandboxName });
}});
export const released = internalMutation({ args: { jobId: v.id("jobs"), sandboxId: v.string(), terminatedBy: v.union(v.literal("orchestrator"), v.literal("sweeper"), v.literal("timeout"), v.literal("self")), exitCode: v.optional(v.number()) }, handler: async (ctx, args) => {
  const rows = await ctx.db.query("sandboxes").withIndex("by_jobId", q => q.eq("jobId", args.jobId)).collect(); const row = rows.find(s => s.sandboxId === args.sandboxId); if (!row) throw Error("NOT_FOUND");
  if (!row.terminatedAt) await ctx.db.patch(row._id, { terminatedAt: Date.now(), terminatedBy: args.terminatedBy, exitCode: args.exitCode });
}});
export const fail = internalMutation({ args: { jobId: v.id("jobs"), errorCode }, handler: async (ctx, args) => { const job = await ctx.db.get(args.jobId); if (!job) throw Error("NOT_FOUND"); if (job.status === "running") { await ctx.db.patch(job._id, { status: "failed", errorCode: args.errorCode, endedAt: Date.now(), leaseUntil: undefined }); await ctx.db.patch(job.sessionId, { status: "failed" }); } }});
export const stale = internalQuery({ args: { heartbeatStaleMs: v.number() }, handler: async (ctx, { heartbeatStaleMs }) => { const now = Date.now(); const jobs = await ctx.db.query("jobs").withIndex("by_status_createdAt", q => q.eq("status", "running")).collect(); return jobs.filter(j => (j.leaseUntil ?? 0) < now || (j.heartbeatAt ?? 0) < now - heartbeatStaleMs); }});
export const openSandboxes = internalQuery({ args: {}, handler: ctx => ctx.db.query("sandboxes").withIndex("by_terminatedAt", q => q.eq("terminatedAt", undefined)).collect() });
export const costsToday = internalQuery({ args: { day: v.string() }, handler: (ctx, { day }) => ctx.db.query("costLedger").withIndex("by_day", q => q.eq("day", day)).collect() });
export { stage };
