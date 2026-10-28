import { canonicalOutput } from "./lib/lifecycle";
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id, Doc } from "./_generated/dataModel";
import { stage, stageStatus } from "./validators";
import { errorCode } from "./errorCodes";
async function runningJob(ctx: MutationCtx, id: Id<"jobs">) {
  const job = await ctx.db.get(id);
  if (!job || job.status !== "running" || (job.leaseUntil ?? 0) <= Date.now())
    throw Error("JOB_NOT_RUNNING");
  return job;
}
const startArgs = {
    jobId: v.id("jobs"),
    stage,
    remarkId: v.optional(v.string()),
    workerId: v.string(),
    attempt: v.number(),
    idempotencyKey: v.string(),
    inputHash: v.string(),
    promptHash: v.optional(v.string()),
    candidate: v.optional(v.string()),
};
export async function startStageRun(ctx: MutationCtx, args: { jobId: Id<"jobs">; stage: Doc<"stageRuns">["stage"]; remarkId?: string; workerId: string; attempt: number; idempotencyKey: string; inputHash: string; promptHash?: string; candidate?: string }) {
    const job = await runningJob(ctx, args.jobId);
    if (
      !Number.isSafeInteger(args.attempt) ||
      args.attempt < 1 ||
      !/^[a-f0-9]{64}$/.test(args.inputHash) ||
      !/^[a-f0-9]{64}$/.test(args.idempotencyKey) ||
      (args.promptHash !== undefined && !/^[a-f0-9]{64}$/.test(args.promptHash))
    )
      throw Error("CONTRACT_INVALID");
    const config = await ctx.db
      .query("pipeline_config")
      .withIndex("by_version", (q) => q.eq("version", job.configVersion))
      .unique();
    const spec = config?.stages.find((s) => s.stage === args.stage);
    if (!spec || !spec.enabled || spec.workerId !== args.workerId)
      throw Error("WORKER_NOT_PINNED");
    if (
      args.attempt > spec.retry + 1 ||
      (args.candidate !== undefined &&
        !spec.candidates.includes(args.candidate))
    )
      throw Error("CONTRACT_INVALID");
    if (
      spec.fanOut === "per_remark" &&
      !args.remarkId &&
      args.stage !== "subject"
    )
      throw Error("REMARK_REQUIRED");
    if (args.remarkId) {
      const remarks = await ctx.db
        .query("remarks")
        .withIndex("by_sessionId", (q) => q.eq("sessionId", job.sessionId))
        .collect();
      if (!remarks.some((r) => r.remarkId === args.remarkId))
        throw Error("NOT_FOUND");
    }
    const prior = await ctx.db
      .query("stageRuns")
      .withIndex("by_idempotencyKey", (q) =>
        q.eq("idempotencyKey", args.idempotencyKey),
      )
      .collect();
    if (
      prior.some(
        (r) =>
          r.jobId !== job._id ||
          r.stage !== args.stage ||
          r.remarkId !== args.remarkId ||
          r.inputHash !== args.inputHash ||
          r.workerId !== args.workerId ||
          r.promptHash !== args.promptHash || r.candidate !== args.candidate,
      )
    )
      throw Error("IDEMPOTENCY_CONFLICT");
    const same = prior.find((r) => r.attempt === args.attempt);
    if (same) return same._id;
    if (args.attempt !== Math.max(0, ...prior.map(r => r.attempt)) + 1) throw Error("ATTEMPT_OUT_OF_ORDER");
    if (prior.some((r) => r.status === "running" || r.status === "done"))
      throw Error("ATTEMPT_ALREADY_ACTIVE_OR_DONE");
    return ctx.db.insert("stageRuns", {
      ...args,
      sessionId: job.sessionId,
      coachId: job.coachId,
      workerType: spec.workerType,
      provider: spec.provider,
      modelVersion: spec.model ?? undefined,
      status: "running",
      startedAt: Date.now(),
    });
}
export const start = internalMutation({
  args: startArgs,
  handler: startStageRun,
});
const finishArgs = {
    stageRunId: v.id("stageRuns"),
    status: stageStatus,
    outputRef: v.optional(v.string()),
    errorCode: v.optional(errorCode),
    errorDetail: v.optional(v.string()),
    samFrames: v.number(),
    inputTokens: v.number(),
    outputTokens: v.number(),
    costUsd: v.number(),
};
export async function finishStageRun(ctx: MutationCtx, args: { stageRunId: Id<"stageRuns">; status: Doc<"stageRuns">["status"]; outputRef?: string; errorCode?: Doc<"stageRuns">["errorCode"]; errorDetail?: string; samFrames: number; inputTokens: number; outputTokens: number; costUsd: number }) {
    const run = await ctx.db.get(args.stageRunId);
    if (!run) throw Error("NOT_FOUND");
    const job = await runningJob(ctx, run.jobId);
    if (
      args.status === "running" ||
      args.status === "queued" ||
      (args.status === "done" && !args.outputRef) ||
      args.errorDetail !== undefined ||
      (args.outputRef !== undefined && !canonicalOutput(args.outputRef, job.sessionId)) ||
      ![args.samFrames, args.inputTokens, args.outputTokens].every(
        (x) => Number.isSafeInteger(x) && x >= 0,
      ) ||
      !Number.isFinite(args.costUsd) ||
      args.costUsd < 0
    )
      throw Error("CONTRACT_INVALID");
    // Raw errorDetail is intentionally rejected: the scrubber belongs to the later worker boundary.
    if (run.status !== "running") {
      if (
        run.status === args.status &&
        run.outputRef === args.outputRef &&
        run.errorCode === args.errorCode &&
        run.samFrames === args.samFrames &&
        run.inputTokens === args.inputTokens &&
        run.outputTokens === args.outputTokens &&
        run.costUsd === args.costUsd
      )
        return;
      throw Error("ATTEMPT_IMMUTABLE");
    }
    const now = Date.now();
    const { stageRunId, ...result } = args;
    await ctx.db.patch(stageRunId, {
      ...result,
      endedAt: now,
      latencyMs: now - (run.startedAt ?? now),
    });
    const config = await ctx.db
      .query("pipeline_config")
      .withIndex("by_version", (q) => q.eq("version", job.configVersion))
      .unique();
    if (!config) throw Error("CONFIG_MISSING");
    const runs = await ctx.db
      .query("stageRuns")
      .withIndex("by_jobId_stage", (q) => q.eq("jobId", job._id))
      .collect();
    const latest = new Map<string, Doc<"stageRuns">>();
    for (const item of runs) {
      const key = `${item.stage}:${item.remarkId ?? ""}`;
      const prev = latest.get(key);
      if (!prev || item.attempt > prev.attempt) latest.set(key, item);
    }
    const remarks = await ctx.db
      .query("remarks")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", job.sessionId))
      .collect();
    const tracked = remarks.filter(
      (r) => r.aboutSubject === "yes" || r.aboutSubject === "unclear",
    );
    const selected = config.stages.filter(
      (s) =>
        s.enabled &&
        (job.kind !== "subject_retrack" ||
          ["subject", "track", "place", "check", "render"].includes(s.stage)) &&
        (job.kind !== "stage_retry" || s.stage === job.stage),
    );
    const terminal = new Set(["done", "skipped", "fallback", "needs_coach"]);
    const rows = config.coachStages
      .map((label) => {
        let total = 0,
          done = 0;
        for (const spec of selected.filter((s) => s.coachLabel === label)) {
          const keys =
            spec.fanOut === "per_remark"
              ? tracked.map((r) => `${spec.stage}:${r.remarkId}`)
              : [`${spec.stage}:`];
          if (spec.stage === "subject") keys.unshift("subject:");
          for (const key of keys) {
            total++;
            if (terminal.has(latest.get(key)?.status ?? "")) done++;
          }
        }
        return { label, total, done };
      })
      .filter((r) => r.total > 0);
    const current = rows.find((r) => r.done < r.total) ?? rows.at(-1);
    const total = rows.reduce((a, r) => a + r.total, 0),
      done = rows.reduce((a, r) => a + r.done, 0);
    await ctx.db.patch(job._id, {
      coachStage: current?.label ?? job.coachStage,
      progress: total ? done / total : 0,
      progressLabel: current ? `${current.done} of ${current.total}` : "0 of 0",
      lastStageDone: args.status === "done" ? run.stage : job.lastStageDone,
      samFrames: job.samFrames + args.samFrames,
      inputTokens: job.inputTokens + args.inputTokens,
      outputTokens: job.outputTokens + args.outputTokens,
      costUsd: job.costUsd + args.costUsd,
    });
}
export const finish = internalMutation({
  args: finishArgs,
  handler: finishStageRun,
});
