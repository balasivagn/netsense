import { expect, test } from "vitest";
import { internal } from "../_generated/api";
import { ready, data } from "./helpers";
async function running() {
  const context = await ready();
  await context.t.mutation(internal.jobs.claim, {
    leaseOwner: data.leaseOwner,
  });
  return context;
}
test("start pins worker metadata and finish advances coach row without double counting", async () => {
  const { t, jobId, sessionId } = await running();
  const args = { ...data.run, stage: "transcode" as const, jobId };
  const run = await t.mutation(internal.stageRuns.start, args);
  expect(await t.mutation(internal.stageRuns.start, args)).toBe(run);
  const finish = {
    ...data.finish,
    outputRef: `sessions/${sessionId}/transcode-output`,
    status: "done" as const,
    stageRunId: run,
    inputTokens: 10,
    costUsd: 0.01,
  };
  await t.mutation(internal.stageRuns.finish, finish);
  await t.mutation(internal.stageRuns.finish, finish);
  const job = await t.run((ctx) => ctx.db.get(jobId));
  expect(job?.coachStage).toBe("Hear your remarks");
  expect(job?.progress).toBeGreaterThan(0);
  expect(job?.progressLabel).toBe("0 of 1");
  expect(job?.inputTokens).toBe(10);
  expect(job?.costUsd).toBe(0.01);
  const stored = await t.run((ctx) => ctx.db.get(run));
  expect(stored?.workerType).toBe("tool");
  expect(stored?.provider).toBe("local");
  await expect(
    t.mutation(internal.stageRuns.finish, { ...finish, inputTokens: 11 }),
  ).rejects.toThrow("ATTEMPT_IMMUTABLE");
});
test("rollup uses the pinned labels after active config changes", async () => {
  const { t, jobId, sessionId } = await running();
  await t.run(async (ctx) => {
    const config = (await ctx.db.query("pipeline_config").collect())[0];
    const { _id, _creationTime, ...copy } = config;
    void _creationTime;
    await ctx.db.patch(_id, { active: false });
    await ctx.db.insert("pipeline_config", {
      ...copy,
      version: 2,
      active: true,
      coachStages: [...copy.coachStages].reverse(),
    });
  });
  const run = await t.mutation(internal.stageRuns.start, {
    ...data.run,
    jobId,
    stage: "transcode",
  });
  await t.mutation(internal.stageRuns.finish, {
    ...data.finish,
    outputRef: `sessions/${sessionId}/transcode-output`,
    stageRunId: run,
    status: "done",
  });
  expect((await t.run((ctx) => ctx.db.get(jobId)))?.coachStage).toBe(
    "Hear your remarks",
  );
});
test("reject wrong worker, invalid attempts, missing output and invalid usage", async () => {
  const { t, jobId, sessionId } = await running();
  const args = { ...data.run, stage: "transcode" as const, jobId };
  await expect(
    t.mutation(internal.stageRuns.start, { ...args, workerId: "not-pinned" }),
  ).rejects.toThrow("WORKER_NOT_PINNED");
  await expect(
    t.mutation(internal.stageRuns.start, { ...args, attempt: 0 }),
  ).rejects.toThrow("CONTRACT_INVALID");
  await expect(
    t.mutation(internal.stageRuns.start, {
      ...args,
      stage: "moment",
      workerId: "moment.spark@1",
    }),
  ).rejects.toThrow("REMARK_REQUIRED");
  const stageRunId = await t.mutation(internal.stageRuns.start, args);
  await expect(
    t.mutation(internal.stageRuns.finish, {
      ...data.finish,
      stageRunId,
      status: "done",
      outputRef: undefined,
    }),
  ).rejects.toThrow("CONTRACT_INVALID");
  await expect(
    t.mutation(internal.stageRuns.finish, {
      ...data.finish,
      outputRef: `sessions/${sessionId}/transcode-output`,
      stageRunId,
      status: "done",
      costUsd: -1,
    }),
  ).rejects.toThrow("CONTRACT_INVALID");
  await expect(
    t.mutation(internal.stageRuns.finish, {
      ...data.finish,
      outputRef: `sessions/${sessionId}/transcode-output`,
      stageRunId,
      status: "done",
      errorDetail: "raw text",
    }),
  ).rejects.toThrow("CONTRACT_INVALID");
});
test("expired lease rejects writes and failed attempts may retry without progress inflation", async () => {
  const { t, jobId, sessionId } = await running();
  const args = { ...data.run, stage: "transcode" as const, jobId };
  const stageRunId = await t.mutation(internal.stageRuns.start, args);
  await t.mutation(internal.stageRuns.finish, {
    ...data.finish,
    stageRunId,
    status: "failed",
    outputRef: undefined,
    errorCode: "VIDEO_DECODE",
  });
  const second = await t.mutation(internal.stageRuns.start, {
    ...args,
    attempt: 2,
  });
  await t.mutation(internal.stageRuns.finish, {
    ...data.finish,
    outputRef: `sessions/${sessionId}/transcode-output`,
    stageRunId: second,
    status: "done",
  });
  const job = await t.run((ctx) => ctx.db.get(jobId));
  expect(job?.progress).toBe(0.2);
  await t.run((ctx) => ctx.db.patch(jobId, { leaseUntil: 0 }));
  await expect(
    t.mutation(internal.stageRuns.start, {
      ...args,
      stage: "transcribe",
      workerId: "transcribe.muse-voice@1",
      idempotencyKey: "3".repeat(64),
    }),
  ).rejects.toThrow("JOB_NOT_RUNNING");
});
test("per-remark progress includes all tracked branches and ignores note-only branches", async () => {
  const { t, jobId, sessionId, coachId } = await running();
  await t.run(async (ctx) => {
    const base = {
      ...data.remark,
      sessionId,
      coachId,
      source: "voice" as const,
      aboutSubject: "yes" as const,
      kind: "feedback" as const,
      mode: "tracked" as const,
      status: "pending" as const,
    };
    await ctx.db.insert("remarks", base);
    await ctx.db.insert("remarks", { ...base, remarkId: "synthetic-r2" });
    await ctx.db.insert("remarks", {
      ...base,
      remarkId: "synthetic-r3",
      aboutSubject: "no",
      mode: "note_only",
    });
  });
  for (const [index, stage, workerId] of [
    [0, "transcode", "transcode.ffmpeg@1"],
    [1, "transcribe", "transcribe.muse-voice@1"],
    [2, "plan", "plan.spark@1"],
  ] as const) {
    const run = await t.mutation(internal.stageRuns.start, {
      ...data.run,
      jobId,
      stage,
      workerId,
      idempotencyKey: String(index + 4).repeat(64),
    });
    await t.mutation(internal.stageRuns.finish, {
      ...data.finish,
      outputRef: `sessions/${sessionId}/transcode-output`,
      stageRunId: run,
      status: "done",
    });
  }
  const job = await t.run((ctx) => ctx.db.get(jobId));
  expect(job?.coachStage).toBe("Match remarks to moments");
  expect(job?.progressLabel).toBe("1 of 6");
  expect(job?.progress).toBe(3 / 15);
});

test("rejects retries beyond config and unconfigured candidates", async () => {
  const { t, jobId } = await running();
  await expect(
    t.mutation(internal.stageRuns.start, {
      ...data.run,
      stage: "transcode",
      jobId,
      attempt: 3,
    }),
  ).rejects.toThrow("CONTRACT_INVALID");
  await expect(
    t.mutation(internal.stageRuns.start, {
      ...data.run,
      stage: "transcode",
      jobId,
      candidate: "unconfigured",
    }),
  ).rejects.toThrow("CONTRACT_INVALID");
});
