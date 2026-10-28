import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { errorCode } from "./errorCodes";
import { stage, stageStatus } from "./validators";
import { finishStageRun, startStageRun } from "./stageRuns";
import { verifyJobToken } from "./lib/jobToken";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

async function live(ctx: MutationCtx, token: string) {
  const secret = process.env.WORKER_TOKEN_SECRET;
  const claims = await verifyJobToken(token, secret ?? "");
  if (!claims) throw Error("WORKER_UNAUTHORIZED");
  const job = await ctx.db.get(claims.jobId as Id<"jobs">);
  if (!job || job.sessionId !== claims.sessionId || job.status !== "running" || (job.leaseUntil ?? 0) <= Date.now()) throw Error("WORKER_UNAUTHORIZED");
  return { claims, job };
}

export const heartbeat = internalMutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const { job } = await live(ctx, token);
    const config = await ctx.db.query("pipeline_config").withIndex("by_version", (q) => q.eq("version", job.configVersion)).unique();
    if (!config) throw Error("CONFIG_MISSING");
    await ctx.db.patch(job._id, { heartbeatAt: Date.now(), leaseUntil: Date.now() + config.limits.jobLeaseS * 1000 });
  },
});

export const start = internalMutation({
  args: { token: v.string(), stage, remarkId: v.optional(v.string()), workerId: v.string(), attempt: v.number(), idempotencyKey: v.string(), inputHash: v.string(), promptHash: v.optional(v.string()), candidate: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { job } = await live(ctx, args.token);
    return startStageRun(ctx, { jobId: job._id, stage: args.stage, remarkId: args.remarkId, workerId: args.workerId, attempt: args.attempt, idempotencyKey: args.idempotencyKey, inputHash: args.inputHash, promptHash: args.promptHash, candidate: args.candidate });
  },
});

export const finish = internalMutation({
  args: { token: v.string(), stageRunId: v.id("stageRuns"), status: stageStatus, outputRef: v.optional(v.string()), errorCode: v.optional(errorCode), samFrames: v.number(), inputTokens: v.number(), outputTokens: v.number(), costUsd: v.number() },
  handler: async (ctx, args) => {
    const { job } = await live(ctx, args.token);
    const run = await ctx.db.get(args.stageRunId);
    if (!run || run.jobId !== job._id || run.sessionId !== job.sessionId) throw Error("WORKER_UNAUTHORIZED");
    if (args.outputRef !== undefined && !args.outputRef.startsWith(`sessions/${job.sessionId}/`)) throw Error("CONTRACT_INVALID");
    await finishStageRun(ctx, { stageRunId: args.stageRunId, status: args.status, outputRef: args.outputRef, errorCode: args.errorCode, samFrames: args.samFrames, inputTokens: args.inputTokens, outputTokens: args.outputTokens, costUsd: args.costUsd });
  },
});

export const done = internalMutation({
  args: { token: v.string(), status: v.union(v.literal("waiting_for_coach"), v.literal("failed"), v.literal("done")), errorCode: v.optional(errorCode) },
  handler: async (ctx, args) => {
    const { job } = await live(ctx, args.token);
    const terminal = job.status !== "running";
    if (terminal) throw Error("WORKER_UNAUTHORIZED");
    const now = Date.now();
    const sessionStatus = args.status === "failed" ? "failed" : args.errorCode === "SUBJECT_NEEDED" || args.errorCode === "SUBJECT_NOT_FOUND" ? "needs_you" : "review_ready";
    await ctx.db.patch(job._id, { status: args.status, ...(args.errorCode ? { errorCode: args.errorCode } : {}), endedAt: now });
    await ctx.db.patch(job.sessionId, { status: sessionStatus, ...(args.errorCode === "SUBJECT_NEEDED" || args.errorCode === "SUBJECT_NOT_FOUND" ? { subjectStatus: "anchor_failed" } : {}) });
  },
});

export const read = internalQuery({
  args: { jobId: v.id("jobs") },
  handler: async (ctx, { jobId }) => {
    const job = await ctx.db.get(jobId);
    if (!job) throw Error("NOT_FOUND");
    const [config, session, uploads, turns, remarks, runs] = await Promise.all([
      ctx.db.query("pipeline_config").withIndex("by_version", (q) => q.eq("version", job.configVersion)).unique(), ctx.db.get(job.sessionId), ctx.db.query("uploads").withIndex("by_sessionId", (q) => q.eq("sessionId", job.sessionId)).collect(), ctx.db.query("transcriptTurns").withIndex("by_sessionId_turnId", (q) => q.eq("sessionId", job.sessionId)).collect(), ctx.db.query("remarks").withIndex("by_sessionId", (q) => q.eq("sessionId", job.sessionId)).collect(), ctx.db.query("stageRuns").withIndex("by_jobId_stage", (q) => q.eq("jobId", job._id)).collect(),
    ]);
    if (!config || !session) throw Error("NOT_FOUND");
    const upload = uploads.find((item) => item.status === "complete");
    if (!upload) throw Error("UPLOAD_MISSING");
    return { job, config, session: { subject: session.subject, subjectAnchor: session.subjectAnchor, renderMode: session.renderMode, durationMs: session.durationMs }, inputs: { uploadId: upload._id, sourceKey: upload.storageKey, declaredBytes: upload.bytesTotal, declaredSha256: upload.sha256, mimeType: upload.mimeType, transcriptTurns: turns, remarks, completedStageRuns: runs.filter((run) => run.status === "done").map((run) => ({ jobId: run.jobId, stageRunId: run._id, idempotencyKey: run.idempotencyKey, stage: run.stage, remarkId: run.remarkId, inputHash: run.inputHash, outputRef: run.outputRef })) } };
  },
});
