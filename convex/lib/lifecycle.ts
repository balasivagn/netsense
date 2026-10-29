import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { PipelineConfig } from "../../packages/contracts/gen/PipelineConfig";

export const sgtDay = (now: number) =>
  new Date(now + 8 * 3_600_000).toISOString().slice(0, 10);
export function configWire(config: Doc<"pipeline_config">): PipelineConfig {
  const { version, note, stages, coachStages, params, limits } = config;
  if (stages.length !== 9 || coachStages.length === 0)
    throw Error("CONFIG_INVALID");
  return {
    version,
    note,
    stages: stages as PipelineConfig["stages"],
    coachStages: coachStages as PipelineConfig["coachStages"],
    params,
    limits,
  };
}
export function jobWire(job: Doc<"jobs">) {
  return {
    id: job._id,
    sessionId: job.sessionId,
    kind: job.kind,
    configVersion: job.configVersion,
    attempt: job.attempt,
    maxAttempts: job.maxAttempts,
    status: job.status,
    leaseOwner: job.leaseOwner ?? null,
    leaseUntil: job.leaseUntil ?? null,
    heartbeatAt: job.heartbeatAt ?? null,
    stage: job.stage ?? null,
    remarkId: job.remarkId ?? null,
  };
}
export async function claimJob(ctx: MutationCtx, leaseOwner: string) {
  if (!leaseOwner.trim() || leaseOwner.length > 160)
    throw Error("INVALID_LEASE_OWNER");
  const now = Date.now();
  const queued = await ctx.db
    .query("jobs")
    .withIndex("by_status_createdAt", (q) => q.eq("status", "queued"))
    .order("asc")
    .collect();
  const job = queued.find((item) => item.attempt < item.maxAttempts);
  if (!job) return null;
  const [config, session] = await Promise.all([
    ctx.db
      .query("pipeline_config")
      .withIndex("by_version", (q) => q.eq("version", job.configVersion))
      .unique(),
    ctx.db.get(job.sessionId),
  ]);
  if (!config || !session || session.coachId !== job.coachId)
    throw Error("CONFIG_OR_SESSION_MISSING");
  const ledger = await ctx.db
    .query("costLedger")
    .withIndex("by_day", (q) => q.eq("day", sgtDay(now)))
    .collect();
  if (
    ledger.reduce((sum, row) => sum + row.usd, 0) >=
    config.limits.dailySpendLimitUsd
  )
    return null;
  // Missing measured duration uses the pinned maximum, never a fabricated source measurement.
  const durationMs =
    session.durationMs ?? config.limits.maxVideoMinutes * 60_000;
  if (!Number.isFinite(durationMs) || durationMs < 0)
    throw Error("INVALID_DURATION");
  const minutes = Math.ceil(durationMs / 60_000);
  const timeoutS = Math.min(
    config.limits.sandboxTimeoutCapS,
    job.kind === "finalize" ? 300 + 60 * minutes : 600 + 180 * minutes,
  );
  const update = {
    status: "running" as const,
    errorCode: undefined,
    endedAt: undefined,
    leaseOwner,
    leaseUntil: now + config.limits.jobLeaseS * 1000,
    heartbeatAt: now,
    startedAt: job.startedAt ?? now,
    attempt: job.attempt + 1,
  };
  await ctx.db.patch(job._id, update);
  return { job: { ...job, ...update }, config: configWire(config), timeoutS };
}
export function canonicalOutput(key: string, sessionId: string): boolean {
  if (
    !key.startsWith(`sessions/${sessionId}/`) ||
    !/^[A-Za-z0-9_./;-]+$/.test(key)
  )
    return false;
  return key
    .split("/")
    .every((part) => part !== "" && part !== "." && part !== "..");
}
