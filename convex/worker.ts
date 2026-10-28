import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { errorCode } from "./errorCodes";
import { stage, stageStatus } from "./validators";
import { finishStageRun, startStageRun } from "./stageRuns";
import { verifyJobToken } from "./lib/jobToken";
import { configWire, jobWire, canonicalOutput } from "./lib/lifecycle";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";

async function authorized(ctx: QueryCtx, token: string) {
  const claims = await verifyJobToken(
    token,
    process.env.WORKER_TOKEN_SECRET ?? "",
  );
  if (!claims) throw Error("WORKER_UNAUTHORIZED");
  const id = ctx.db.normalizeId("jobs", claims.jobId);
  const job = id ? await ctx.db.get(id) : null;
  const session = job ? await ctx.db.get(job.sessionId) : null;
  if (
    !job ||
    !session ||
    job.sessionId !== claims.sessionId ||
    session.coachId !== job.coachId
  )
    throw Error("WORKER_UNAUTHORIZED");
  return { job, session };
}
async function live(ctx: QueryCtx | MutationCtx, token: string) {
  const result = await authorized(ctx, token);
  if (
    result.session.latestJobId !== result.job._id ||
    result.job.status !== "running" ||
    (result.job.leaseUntil ?? 0) <= Date.now()
  )
    throw Error("WORKER_UNAUTHORIZED");
  return result;
}

export const heartbeat = internalMutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const { job } = await live(ctx, token);
    const config = await ctx.db
      .query("pipeline_config")
      .withIndex("by_version", (q) => q.eq("version", job.configVersion))
      .unique();
    if (!config) throw Error("CONFIG_MISSING");
    await ctx.db.patch(job._id, {
      heartbeatAt: Date.now(),
      leaseUntil: Date.now() + config.limits.jobLeaseS * 1000,
    });
  },
});

export const start = internalMutation({
  args: {
    token: v.string(),
    stage,
    remarkId: v.optional(v.string()),
    workerId: v.string(),
    attempt: v.number(),
    idempotencyKey: v.string(),
    inputHash: v.string(),
    promptHash: v.optional(v.string()),
    candidate: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { job } = await live(ctx, args.token);
    return startStageRun(ctx, {
      jobId: job._id,
      stage: args.stage,
      remarkId: args.remarkId,
      workerId: args.workerId,
      attempt: args.attempt,
      idempotencyKey: args.idempotencyKey,
      inputHash: args.inputHash,
      promptHash: args.promptHash,
      candidate: args.candidate,
    });
  },
});

export const finish = internalMutation({
  args: {
    token: v.string(),
    stageRunId: v.id("stageRuns"),
    status: stageStatus,
    outputRef: v.optional(v.string()),
    errorCode: v.optional(errorCode),
    samFrames: v.number(),
    inputTokens: v.number(),
    outputTokens: v.number(),
    costUsd: v.number(),
  },
  handler: async (ctx, args) => {
    const { job } = await live(ctx, args.token);
    const run = await ctx.db.get(args.stageRunId);
    if (
      !run ||
      run.jobId !== job._id ||
      run.sessionId !== job.sessionId ||
      run.coachId !== job.coachId
    )
      throw Error("WORKER_UNAUTHORIZED");
    if (
      args.outputRef !== undefined &&
      !canonicalOutput(args.outputRef, job.sessionId)
    )
      throw Error("CONTRACT_INVALID");
    await finishStageRun(ctx, {
      stageRunId: args.stageRunId,
      status: args.status,
      outputRef: args.outputRef,
      errorCode: args.errorCode,
      samFrames: args.samFrames,
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
      costUsd: args.costUsd,
    });
  },
});

export const done = internalMutation({
  args: {
    token: v.string(),
    status: v.union(
      v.literal("waiting_for_coach"),
      v.literal("failed"),
      v.literal("done"),
    ),
    errorCode: v.optional(errorCode),
  },
  handler: async (ctx, args) => {
    const { job, session } = await authorized(ctx, args.token);
    if (job.status !== "running") {
      if (
        job.endedAt !== undefined &&
        job.leaseUntil !== undefined &&
        job.status === args.status &&
        job.errorCode === args.errorCode
      )
        return;
      throw Error("WORKER_UNAUTHORIZED");
    }
    if ((job.leaseUntil ?? 0) <= Date.now() || session.latestJobId !== job._id)
      throw Error("WORKER_UNAUTHORIZED");
    const now = Date.now();
    const sessionStatus =
      args.status === "failed"
        ? "failed"
        : args.errorCode && args.errorCode !== "RENDER_FAIL"
          ? "needs_you"
          : "review_ready";
    await ctx.db.patch(job._id, {
      status: args.status,
      errorCode: args.errorCode,
      endedAt: now,
    });
    await ctx.db.patch(job.sessionId, {
      status: sessionStatus,
      ...(args.errorCode === "SUBJECT_NEEDED"
        ? { subjectStatus: "anchor_failed" }
        : {}),
    });
  },
});

async function completedInputs(ctx: QueryCtx, job: Doc<"jobs">) {
  const jobs =
    job.kind === "subject_retrack"
      ? await ctx.db
          .query("jobs")
          .withIndex("by_sessionId", (q) => q.eq("sessionId", job.sessionId))
          .collect()
      : [job];
  const runs = await Promise.all(
    jobs
      .filter(
        (prior) =>
          prior.coachId === job.coachId &&
          prior._creationTime <= job._creationTime,
      )
      .map((prior) =>
        ctx.db
          .query("stageRuns")
          .withIndex("by_jobId_stage", (q) => q.eq("jobId", prior._id))
          .collect(),
      ),
  );
  return runs
    .flat()
    .filter(
      (run) =>
        run.sessionId === job.sessionId &&
        run.coachId === job.coachId &&
        (run.jobId === job._id ||
          ["transcode", "transcribe", "plan", "moment"].includes(run.stage)),
    );
}

export const read = internalQuery({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const { job } = await live(ctx, token);
    const [config, session, uploads, turns, remarks, runs] = await Promise.all([
      ctx.db
        .query("pipeline_config")
        .withIndex("by_version", (q) => q.eq("version", job.configVersion))
        .unique(),
      ctx.db.get(job.sessionId),
      ctx.db
        .query("uploads")
        .withIndex("by_sessionId", (q) => q.eq("sessionId", job.sessionId))
        .collect(),
      ctx.db
        .query("transcriptTurns")
        .withIndex("by_sessionId_turnId", (q) =>
          q.eq("sessionId", job.sessionId),
        )
        .collect(),
      ctx.db
        .query("remarks")
        .withIndex("by_sessionId", (q) => q.eq("sessionId", job.sessionId))
        .collect(),
      completedInputs(ctx, job),
    ]);
    if (!config || !session) throw Error("NOT_FOUND");
    const upload = uploads.find(
      (item) => item.status === "complete" && item.coachId === job.coachId,
    );
    if (!upload) throw Error("UPLOAD_MISSING");
    return {
      job: jobWire(job),
      config: configWire(config),
      session: {
        subject: session.subject ?? null,
        subjectAnchor: session.subjectAnchor ?? null,
        renderMode: session.renderMode,
        durationMs: session.durationMs ?? null,
      },
      inputs: {
        uploadId: upload._id,
        sourceKey: upload.storageKey,
        declaredBytes: upload.bytesTotal,
        declaredSha256: upload.sha256,
        mimeType: upload.mimeType,
        transcriptTurns: turns.map((turn) => ({
          turnId: turn.turnId,
          startMs: turn.startMs,
          endMs: turn.endMs,
          speaker: turn.speaker,
          text: turn.text,
          correctedText: turn.correctedText ?? null,
        })),
        remarks: remarks.map(
          ({
            remarkId,
            turnIds,
            source,
            aboutSubject,
            kind,
            atMs,
            mode,
            momentStartMs,
            momentEndMs,
            keyframeMs,
            momentWhy,
            status,
            includeInShare,
          }) => ({
            remarkId,
            turnIds,
            source,
            aboutSubject,
            kind,
            atMs,
            mode,
            momentStartMs: momentStartMs ?? null,
            momentEndMs: momentEndMs ?? null,
            keyframeMs: keyframeMs ?? null,
            momentWhy: momentWhy ?? null,
            status,
            includeInShare,
          }),
        ),
        completedStageRuns: runs
          .filter(
            (run) =>
              run.status === "done" &&
              run.outputRef !== undefined &&
              canonicalOutput(run.outputRef, job.sessionId),
          )
          .map((run) => ({
            jobId: run.jobId,
            stageRunId: run._id,
            idempotencyKey: run.idempotencyKey,
            stage: run.stage,
            remarkId: run.remarkId ?? null,
            inputHash: run.inputHash,
            outputRef: run.outputRef,
          })),
      },
    };
  },
});
