import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ready, data } from "./helpers";
import { signJobToken, verifyJobToken } from "../lib/jobToken";
import Ajv2020 from "ajv/dist/2020";
import { loadSchemas } from "../../scripts/schema-utils";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { PipelineConfig } from "../../packages/contracts/gen/PipelineConfig";

type TestCtx = Awaited<ReturnType<typeof ready>>;
type Claimed = {
  job: {
    id: Id<"jobs">;
    sessionId: Id<"sessions">;
    kind: Doc<"jobs">["kind"];
    configVersion: number;
    attempt: number;
    maxAttempts: number;
    leaseOwner: string;
    leaseUntil: number;
    heartbeatAt: number;
    stage: string | null;
    remarkId: string | null;
  };
  config: PipelineConfig;
  jobToken: string;
  timeoutS: number;
};
const ajv = new Ajv2020({ strict: true });
for (const schema of Object.values(loadSchemas())) ajv.addSchema(schema);
let serviceSecret: string;
let workerSecret: string;
beforeEach(() => {
  serviceSecret = crypto.randomUUID();
  workerSecret = crypto.randomUUID();
  vi.stubEnv("CONVEX_SERVICE_SECRET", serviceSecret);
  vi.stubEnv("WORKER_TOKEN_SECRET", workerSecret);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
const headers = (token = serviceSecret) => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
});
const post = (value: unknown, token = serviceSecret): RequestInit => ({
  method: "POST",
  headers: headers(token),
  body: JSON.stringify(value),
});
async function claim(t: TestCtx["t"]): Promise<Claimed> {
  const response = await t.fetch(
    "/svc/jobs/claim",
    post({ leaseOwner: data.leaseOwner }),
  );
  expect(response.status).toBe(200);
  return response.json();
}
async function running() {
  const context = await ready();
  return { ...context, claimed: await claim(context.t) };
}
const startInput = () => ({ ...data.run, stage: "transcode" });
async function start(context: Awaited<ReturnType<typeof running>>) {
  const response = await context.t.fetch(
    "/worker/stageRuns/start",
    post(startInput(), context.claimed.jobToken),
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { stageRunId: Id<"stageRuns"> })
    .stageRunId;
}
const finishInput = (
  stageRunId: Id<"stageRuns">,
  sessionId: Id<"sessions">,
) => ({
  ...data.finish,
  stageRunId,
  outputRef: `sessions/${sessionId}/transcode-output`,
  samFrames: 5,
  inputTokens: 10,
  outputTokens: 2,
  costUsd: 0.01,
});

const serviceRoutes = [
  "/svc/jobs/claim",
  "/svc/jobs/sandbox",
  "/svc/jobs/released",
  "/svc/jobs/fail",
  "/svc/jobs/control",
  "/svc/jobs/stale",
  "/svc/sandboxes/open",
];
describe("service authentication", () => {
  test.each(serviceRoutes)(
    "%s fails closed before any database change",
    async (path) => {
      const { t, jobId } = await ready();
      const before = await t.run((ctx) => ctx.db.get(jobId));
      for (const auth of [undefined, crypto.randomUUID()]) {
        const init =
          path.endsWith("stale") || path.endsWith("open")
            ? {}
            : { method: "POST", body: "{}" };
        const response = await t.fetch(path, {
          ...init,
          headers: auth ? headers(auth) : {},
        });
        expect(response.status).toBe(401);
      }
      vi.stubEnv("CONVEX_SERVICE_SECRET", "");
      expect(
        (
          await t.fetch(
            path,
            path.endsWith("stale") || path.endsWith("open")
              ? { headers: headers() }
              : post({}),
          )
        ).status,
      ).toBe(401);
      expect(await t.run((ctx) => ctx.db.get(jobId))).toEqual(before);
      expect(await t.run((ctx) => ctx.db.query("sandboxes").collect())).toEqual(
        [],
      );
    },
  );
  test("unset worker secret fails before the atomic claim", async () => {
    const { t, jobId } = await ready();
    vi.stubEnv("WORKER_TOKEN_SECRET", "");
    expect(
      (await t.fetch("/svc/jobs/claim", post({ leaseOwner: data.leaseOwner })))
        .status,
    ).toBe(503);
    expect(await t.run((ctx) => ctx.db.get(jobId))).toMatchObject({
      status: "queued",
      attempt: 0,
    });
  });
});

describe("claim projection, timeout and budget", () => {
  test("simultaneous HTTP claims have one winner and return pinned config without Convex metadata", async () => {
    const { t, jobId, sessionId } = await ready();
    const config = await t.run(async (ctx) => {
      const old = (await ctx.db.query("pipeline_config").collect())[0];
      const { _id, _creationTime, ...copy } = old;
      void _creationTime;
      await ctx.db.patch(_id, { active: false });
      await ctx.db.insert("pipeline_config", {
        ...copy,
        version: 2,
        active: true,
        limits: { ...copy.limits, jobLeaseS: 1 },
      });
      return old;
    });
    const results = await Promise.all([
      t.fetch("/svc/jobs/claim", post({ leaseOwner: data.leaseOwner })),
      t.fetch("/svc/jobs/claim", post({ leaseOwner: data.leaseOwner + "-2" })),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 204]);
    const result: Claimed = await results.find((r) => r.status === 200)!.json();
    expect(result.job).toMatchObject({
      id: jobId,
      sessionId,
      kind: "pipeline",
      configVersion: 1,
      attempt: 1,
      maxAttempts: config.limits.jobMaxAttempts,
      stage: null,
      remarkId: null,
    });
    expect(Object.keys(result.config).sort()).toEqual(
      ["version", "note", "stages", "coachStages", "params", "limits"].sort(),
    );
    expect(result.config.version).toBe(1);
    expect(ajv.getSchema("PipelineConfig.json")!(result.config)).toBe(true);
    expect(result.job.leaseUntil - result.job.heartbeatAt).toBe(
      config.limits.jobLeaseS * 1000,
    );
    const stored = await t.run((ctx) => ctx.db.get(jobId));
    expect(stored).toMatchObject({
      status: "running",
      attempt: 1,
      leaseUntil: result.job.leaseUntil,
    });
    expect(await verifyJobToken(result.jobToken, workerSecret)).toEqual({
      jobId,
      sessionId,
      exp: result.job.heartbeatAt + (result.timeoutS + 300) * 1000,
    });
  });
  test.each([
    ["pipeline", 0, 600],
    ["pipeline", 60000, 780],
    ["pipeline", 60001, 960],
    ["finalize", 60000, 360],
    ["finalize", 60001, 420],
    ["pipeline", 6000000, 2400],
  ] as const)(
    "%s duration %i uses timeout %i even with no enabled stages",
    async (kind, durationMs, timeout) => {
      const { t, jobId, sessionId } = await ready();
      await t.run(async (ctx) => {
        await ctx.db.patch(sessionId, { durationMs });
        await ctx.db.patch(jobId, { kind });
        const config = (await ctx.db.query("pipeline_config").collect())[0];
        await ctx.db.patch(config._id, {
          stages: config.stages.map((s) => ({ ...s, enabled: false })),
          limits: { ...config.limits, sandboxTimeoutCapS: 2400 },
        });
      });
      const result = await claim(t);
      expect(result.timeoutS).toBe(timeout);
      expect(await t.run((ctx) => ctx.db.get(jobId))).toMatchObject({
        status: "running",
        attempt: 1,
      });
    },
  );
  test("SGT midnight selects the actual daily ledger, including other coaches", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-28T15:59:59Z"));
    const { t, jobId, coachId } = await ready();
    await t.run(async (ctx) => {
      const config = (await ctx.db.query("pipeline_config").collect())[0];
      const otherCoach = (await ctx.db.query("coaches").collect()).find(
        (row) => row._id !== coachId,
      )!;
      await ctx.db.insert("costLedger", {
        coachId: otherCoach._id,
        day: "2026-10-28",
        jobId,
        stage: "track",
        provider: "meta",
        units: "samFrames",
        quantity: 1,
        usd: config.limits.dailySpendLimitUsd,
      });
      await ctx.db.insert("costLedger", {
        coachId,
        day: "2026-10-27",
        jobId,
        stage: "track",
        provider: "meta",
        units: "samFrames",
        quantity: 1,
        usd: config.limits.dailySpendLimitUsd,
      });
    });
    expect(
      (await t.fetch("/svc/jobs/claim", post({ leaseOwner: data.leaseOwner })))
        .status,
    ).toBe(204);
    expect(await t.run((ctx) => ctx.db.get(jobId))).toMatchObject({
      status: "queued",
      attempt: 0,
    });
    vi.setSystemTime(new Date("2026-10-28T16:00:00Z"));
    await claim(t);
    expect(await t.run((ctx) => ctx.db.get(jobId))).toMatchObject({
      status: "running",
      attempt: 1,
    });
  });
});

const workerPaths = [
  "/worker/job",
  "/worker/heartbeat",
  "/worker/stageRuns/start",
  "/worker/stageRuns/finish",
  "/worker/done",
];
async function workerCall(
  context: Awaited<ReturnType<typeof running>>,
  path: string,
  token: string,
  runId: Id<"stageRuns">,
) {
  return context.t.fetch(
    path,
    path === "/worker/job"
      ? { headers: headers(token) }
      : post(
          path.endsWith("start")
            ? startInput()
            : path.endsWith("finish")
              ? finishInput(runId, context.sessionId)
              : path.endsWith("done")
                ? { status: "done" }
                : {},
          token,
        ),
  );
}
describe("atomic worker authorization on every route", () => {
  test.each([
    "cross-session",
    "cancelled",
    "done",
    "waiting_for_coach",
    "failed",
    "expired-lease",
    "equal-lease",
  ])(
    "%s denies every worker read and write without altering rows",
    async (mode) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-28T10:00:00Z"));
      const context = await running();
      const { t, jobId, sessionId, claimed } = context;
      const runId = await start(context);
      let token = claimed.jobToken;
      if (mode === "cross-session") {
        const session = await t.run(async (ctx) => {
          const original = (await ctx.db.get(sessionId))!;
          const { _id, _creationTime, ...copy } = original;
          void _id;
          void _creationTime;
          return ctx.db.insert("sessions", copy);
        });
        token = await signJobToken(
          { jobId, sessionId: session, exp: Date.now() + 100000 },
          workerSecret,
        );
      } else
        await t.run((ctx) =>
          ctx.db.patch(
            jobId,
            mode.endsWith("lease")
              ? { leaseUntil: Date.now() - (mode === "equal-lease" ? 0 : 1) }
              : {
                  status: mode as
                    "cancelled" | "done" | "waiting_for_coach" | "failed",
                },
          ),
        );
      const before = await t.run(async (ctx) => ({
        job: await ctx.db.get(jobId),
        session: await ctx.db.get(sessionId),
        run: await ctx.db.get(runId),
      }));
      for (const path of workerPaths)
        expect(
          (await workerCall(context, path, token, runId)).status,
          path,
        ).toBe(403);
      expect(
        await t.run(async (ctx) => ({
          job: await ctx.db.get(jobId),
          session: await ctx.db.get(sessionId),
          run: await ctx.db.get(runId),
        })),
      ).toEqual(before);
    },
  );
  test("invalid signature or empty worker secret denies every route", async () => {
    const context = await running();
    const run = await start(context);
    for (const path of workerPaths)
      expect(
        (await workerCall(context, path, context.claimed.jobToken + "x", run))
          .status,
      ).toBe(401);
    vi.stubEnv("WORKER_TOKEN_SECRET", "");
    for (const path of workerPaths)
      expect(
        (await workerCall(context, path, context.claimed.jobToken, run)).status,
      ).toBe(401);
    expect(await context.t.run((ctx) => ctx.db.get(run))).toMatchObject({
      status: "running",
    });
  });
  test("heartbeat extends the live lease with pinned limits", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-28T10:00:00Z"));
    const { t, jobId, claimed } = await running();
    vi.advanceTimersByTime(1000);
    expect(
      (await t.fetch("/worker/heartbeat", post({}, claimed.jobToken))).status,
    ).toBe(200);
    expect(await t.run((ctx) => ctx.db.get(jobId))).toMatchObject({
      heartbeatAt: Date.now(),
      leaseUntil: Date.now() + claimed.config.limits.jobLeaseS * 1000,
    });
  });
});

describe("stage lifecycle", () => {
  test("start and finish persist pinned metadata, refs and usage once; completed artifacts are readable", async () => {
    const context = await running();
    const { t, jobId, sessionId, claimed } = context;
    const stageRunId = await start(context);
    expect(await start(context)).toBe(stageRunId);
    const args = finishInput(stageRunId, sessionId);
    expect(
      (await t.fetch("/worker/stageRuns/finish", post(args, claimed.jobToken)))
        .status,
    ).toBe(200);
    const before = await t.run((ctx) => ctx.db.get(stageRunId));
    expect(before).toMatchObject({
      jobId,
      sessionId,
      workerId: data.run.workerId,
      workerType: "tool",
      provider: "local",
      status: "done",
      outputRef: args.outputRef,
      inputTokens: 10,
      outputTokens: 2,
      costUsd: 0.01,
    });
    expect(
      (await t.fetch("/worker/stageRuns/finish", post(args, claimed.jobToken)))
        .status,
    ).toBe(200);
    expect(await t.run((ctx) => ctx.db.get(stageRunId))).toEqual(before);
    expect(await t.run((ctx) => ctx.db.get(jobId))).toMatchObject({
      inputTokens: 10,
      outputTokens: 2,
      costUsd: 0.01,
    });
    expect(
      (
        await t.fetch(
          "/worker/stageRuns/finish",
          post({ ...args, costUsd: 1 }, claimed.jobToken),
        )
      ).status,
    ).toBe(403);
    const read = await t.fetch("/worker/job", {
      headers: headers(claimed.jobToken),
    });
    expect(read.status).toBe(200);
    const wire = await read.json();
    expect(wire.inputs.completedStageRuns).toEqual([
      {
        jobId,
        stageRunId,
        idempotencyKey: data.run.idempotencyKey,
        stage: "transcode",
        remarkId: null,
        inputHash: data.run.inputHash,
        outputRef: args.outputRef,
      },
    ]);
    expect(wire.inputs).toMatchObject({
      uploadId: context.uploadId,
      sourceKey: data.upload.storageKey,
      declaredBytes: data.upload.bytesTotal,
      declaredSha256: data.upload.sha256,
      mimeType: data.upload.mimeType,
    });
    expect(wire.session).toMatchObject({
      subject: { ...data.subject, selectedBy: "coach" },
      subjectAnchor: null,
      durationMs: 2000,
      renderMode: "video",
    });
    expect(JSON.stringify(wire)).not.toContain('"_id"');
    expect(JSON.stringify(wire)).not.toContain('"_creationTime"');
  });
  test.each([
    "../escape",
    "a/../escape",
    "a\\escape",
    "%2e%2e/escape",
    "%252e%252e/escape",
    "a//escape",
    "/escape",
    "a?token=x",
  ])("rejects noncanonical output suffix %s", async (suffix) => {
    const context = await running();
    const run = await start(context);
    const args = {
      ...finishInput(run, context.sessionId),
      outputRef: `sessions/${context.sessionId}/${suffix}`,
    };
    expect(
      (
        await context.t.fetch(
          "/worker/stageRuns/finish",
          post(args, context.claimed.jobToken),
        )
      ).status,
    ).toBe(403);
    expect(await context.t.run((ctx) => ctx.db.get(run))).toMatchObject({
      status: "running",
    });
    expect(
      await context.t.run((ctx) => ctx.db.get(context.jobId)),
    ).toMatchObject({ costUsd: 0 });
  });
  test("foreign stage runs, foreign refs and raw error detail never persist", async () => {
    const context = await running();
    const { t, jobId, sessionId, claimed } = context;
    const run = await start(context);
    const foreignRun = await t.run(async (ctx) => {
      const original = (await ctx.db.get(jobId))!;
      const { _id, _creationTime, ...copy } = original;
      void _id;
      void _creationTime;
      const foreignJob = await ctx.db.insert("jobs", copy);
      const originalRun = (await ctx.db.get(run))!;
      const { _id: runId, _creationTime: created, ...runCopy } = originalRun;
      void runId;
      void created;
      return ctx.db.insert("stageRuns", { ...runCopy, jobId: foreignJob });
    });
    for (const args of [
      { ...finishInput(foreignRun, sessionId) },
      { ...finishInput(run, sessionId), outputRef: "sessions/foreign/output" },
      { ...finishInput(run, sessionId), errorDetail: data.annotation.why },
    ]) {
      expect(
        (
          await t.fetch(
            "/worker/stageRuns/finish",
            post(args, claimed.jobToken),
          )
        ).status,
      ).toBe(403);
    }
    expect(await t.run((ctx) => ctx.db.get(run))).toMatchObject({
      status: "running",
    });
    expect(await t.run((ctx) => ctx.db.get(foreignRun))).toMatchObject({
      status: "running",
    });
  });
  test.each([
    { workerId: "unregistered" },
    { attempt: 0 },
    { attempt: 3 },
    { attempt: 2 },
    { inputHash: "invalid" },
    { promptHash: "invalid" },
    { candidate: "unconfigured" },
  ])("rejects invalid pinned start %#", async (change) => {
    const context = await running();
    expect(
      (
        await context.t.fetch(
          "/worker/stageRuns/start",
          post({ ...startInput(), ...change }, context.claimed.jobToken),
        )
      ).status,
    ).toBe(403);
    expect(
      await context.t.run((ctx) => ctx.db.query("stageRuns").collect()),
    ).toEqual([]);
  });
});

describe("completion state machine", () => {
  test.each([
    ["waiting_for_coach", undefined, "review_ready", "set"],
    ["waiting_for_coach", "NO_SPEECH", "needs_you", "set"],
    ["waiting_for_coach", "AUDIO_DECODE", "needs_you", "set"],
    ["waiting_for_coach", "SEG_NO_TRACK", "needs_you", "set"],
    ["waiting_for_coach", "SUBJECT_NEEDED", "needs_you", "anchor_failed"],
    ["waiting_for_coach", "SUBJECT_NOT_FOUND", "needs_you", "set"],
    ["waiting_for_coach", "SUBJECT_SWAP", "needs_you", "set"],
    ["waiting_for_coach", "BUDGET_DAILY", "needs_you", "set"],
    ["waiting_for_coach", "RENDER_FAIL", "review_ready", "set"],
    ["failed", "INFRA_EXEC", "failed", "set"],
    ["done", undefined, "review_ready", "set"],
  ] as const)(
    "%s / %s maps to %s and accepts only identical terminal replay",
    async (status, errorCode, sessionStatus, subjectStatus) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-28T10:00:00Z"));
      const { t, jobId, sessionId, claimed } = await running();
      const args = { status, ...(errorCode ? { errorCode } : {}) };
      expect(
        (await t.fetch("/worker/done", post(args, claimed.jobToken))).status,
      ).toBe(200);
      const before = await t.run(async (ctx) => ({
        job: await ctx.db.get(jobId),
        session: await ctx.db.get(sessionId),
      }));
      expect(before.job).toMatchObject({ status, costUsd: 0 });
      expect(before.job?.endedAt).toBeGreaterThanOrEqual(Date.now());
      expect(before.session).toMatchObject({
        status: sessionStatus,
        subjectStatus,
      });
      vi.advanceTimersByTime(61_000); // lease is expired, token remains valid: only exact done replay may pass.
      expect(
        (
          await t.fetch(
            "/worker/done",
            post(
              { status: status === "done" ? "failed" : "done" },
              claimed.jobToken,
            ),
          )
        ).status,
      ).toBe(403);
      expect(
        (await t.fetch("/worker/done", post(args, claimed.jobToken))).status,
      ).toBe(200);
      expect(
        (
          await t.fetch(
            "/worker/done",
            post({ status, errorCode: "CONTRACT_INVALID" }, claimed.jobToken),
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await t.fetch(
            "/svc/jobs/fail",
            post({ jobId, errorCode: "SANDBOX_LOST" }),
          )
        ).status,
      ).toBe(200);
      expect(
        await t.run(async (ctx) => ({
          job: await ctx.db.get(jobId),
          session: await ctx.db.get(sessionId),
        })),
      ).toEqual(before);
    },
  );
});

describe("sandbox lifecycle and sweeper lists", () => {
  test("registration, conflict, release and later attempt preserve exact sandbox metadata", async () => {
    const { t, jobId, claimed } = await running();
    const one = {
      jobId,
      sandboxId: crypto.randomUUID(),
      sandboxName: data.leaseOwner,
      driver: "local",
    };
    expect((await t.fetch("/svc/jobs/sandbox", post(one))).status).toBe(200);
    const first = await t.run((ctx) => ctx.db.query("sandboxes").collect());
    expect(first).toHaveLength(1);
    expect((await t.fetch("/svc/jobs/sandbox", post(one))).status).toBe(200);
    expect(await t.run((ctx) => ctx.db.query("sandboxes").collect())).toEqual(
      first,
    );
    const two = { ...one, sandboxId: crypto.randomUUID() };
    expect((await t.fetch("/svc/jobs/sandbox", post(two))).status).toBe(400);
    expect(
      await (
        await t.fetch("/svc/sandboxes/open", { headers: headers() })
      ).json(),
    ).toEqual(first);
    const release = {
      jobId,
      sandboxId: one.sandboxId,
      terminatedBy: "sweeper",
      exitCode: 137,
    };
    expect((await t.fetch("/svc/jobs/released", post(release))).status).toBe(
      200,
    );
    expect((await t.fetch("/svc/jobs/sandbox", post(one))).status).toBe(200);
    const released = await t.run((ctx) => ctx.db.get(first[0]._id));
    expect(released).toMatchObject({ terminatedBy: "sweeper", exitCode: 137 });
    expect((await t.fetch("/svc/jobs/released", post(release))).status).toBe(
      200,
    );
    expect(await t.run((ctx) => ctx.db.get(first[0]._id))).toEqual(released);
    expect(
      (await t.fetch("/svc/jobs/released", post({ ...release, exitCode: 0 })))
        .status,
    ).toBe(400);
    expect(
      await (
        await t.fetch("/svc/sandboxes/open", { headers: headers() })
      ).json(),
    ).toEqual([]);
    await t.run((ctx) => ctx.db.patch(jobId, { status: "queued" }));
    const next = await claim(t);
    expect(next.job.attempt).toBe(claimed.job.attempt + 1);
    expect((await t.fetch("/svc/jobs/sandbox", post(two))).status).toBe(200);
    expect((await t.fetch("/svc/jobs/released", post(release))).status).toBe(
      200,
    );
    const open = await (
      await t.fetch("/svc/sandboxes/open", { headers: headers() })
    ).json();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ sandboxId: two.sandboxId, jobId });
    expect(await t.run((ctx) => ctx.db.get(jobId))).toMatchObject({
      sandboxId: two.sandboxId,
      status: "running",
    });
    const releaseTwo = {
      jobId,
      sandboxId: two.sandboxId,
      terminatedBy: "orchestrator",
      exitCode: null,
    };
    expect((await t.fetch("/svc/jobs/released", post(releaseTwo))).status).toBe(
      200,
    );
    expect((await t.fetch("/svc/jobs/released", post(releaseTwo))).status).toBe(
      200,
    );
    expect(
      await (
        await t.fetch("/svc/sandboxes/open", { headers: headers() })
      ).json(),
    ).toEqual([]);
  });
  test.each(["expired", "stopped"])(
    "%s job cannot register a sandbox",
    async (mode) => {
      const { t, jobId } = await running();
      await t.run((ctx) =>
        ctx.db.patch(
          jobId,
          mode === "expired" ? { leaseUntil: Date.now() } : { status: "done" },
        ),
      );
      expect(
        (
          await t.fetch(
            "/svc/jobs/sandbox",
            post({
              jobId,
              sandboxId: crypto.randomUUID(),
              sandboxName: data.leaseOwner,
              driver: "local",
            }),
          )
        ).status,
      ).toBe(400);
      expect(await t.run((ctx) => ctx.db.query("sandboxes").collect())).toEqual(
        [],
      );
    },
  );
  test("stale list uses default 90s, expired leases and rejects invalid environment", async () => {
    const { t, jobId } = await running();
    delete process.env.HEARTBEAT_STALE_S;
    expect(
      await (await t.fetch("/svc/jobs/stale", { headers: headers() })).json(),
    ).toEqual([]);
    await t.run((ctx) =>
      ctx.db.patch(jobId, {
        heartbeatAt: Date.now() - 91_000,
        leaseUntil: Date.now() + 100000,
      }),
    );
    const row = await t.run((ctx) => ctx.db.get(jobId));
    expect(
      await (await t.fetch("/svc/jobs/stale", { headers: headers() })).json(),
    ).toEqual([row]);
    await t.run((ctx) =>
      ctx.db.patch(jobId, {
        heartbeatAt: Date.now(),
        leaseUntil: Date.now() - 1,
      }),
    );
    expect(
      await (await t.fetch("/svc/jobs/stale", { headers: headers() })).json(),
    ).toEqual([await t.run((ctx) => ctx.db.get(jobId))]);
    for (const invalid of ["NaN", "0", "-1", "Infinity", ""]) {
      vi.stubEnv("HEARTBEAT_STALE_S", invalid);
      expect(
        (await t.fetch("/svc/jobs/stale", { headers: headers() })).status,
      ).toBe(503);
    }
    expect(await t.run((ctx) => ctx.db.get(jobId))).toMatchObject({
      status: "running",
    });
  });
});

describe("bounded and closed HTTP input", () => {
  test.each([undefined, "1"])(
    "streamed byte limit works with content-length %s",
    async (length) => {
      const { t, jobId } = await ready();
      const bytes = new TextEncoder().encode(
        JSON.stringify({ leaseOwner: "x".repeat(40000) }),
      );
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < bytes.length; i += 4096)
            controller.enqueue(bytes.slice(i, i + 4096));
          controller.close();
        },
      });
      const response = await t.fetch("/svc/jobs/claim", {
        method: "POST",
        headers: {
          ...headers(),
          ...(length ? { "content-length": length } : {}),
        },
        body: stream,
        duplex: "half",
      } as RequestInit & { duplex: string });
      expect(response.status).toBe(400);
      expect(await t.run((ctx) => ctx.db.get(jobId))).toMatchObject({
        status: "queued",
        attempt: 0,
      });
    },
  );
  test("malformed JSON, unknown fields, invalid enums/ids never mutate or leak errors", async () => {
    const context = await running();
    const { t, jobId, claimed } = context;
    const runId = await start(context);
    const before = await t.run((ctx) => ctx.db.get(jobId));
    const cases: [string, unknown][] = [
      ["/worker/done", { status: "arbitrary" }],
      ["/worker/done", { status: "done", unknown: true }],
      [
        "/worker/stageRuns/finish",
        { ...finishInput(runId, context.sessionId), stageRunId: "malformed" },
      ],
      ["/svc/jobs/fail", { jobId, errorCode: "arbitrary" }],
      [
        "/svc/jobs/released",
        { jobId, sandboxId: "x", terminatedBy: "arbitrary" },
      ],
      [
        "/svc/jobs/sandbox",
        { jobId, sandboxId: "x", sandboxName: "x", driver: "arbitrary" },
      ],
    ];
    for (const [path, args] of cases) {
      const response = await t.fetch(
        path,
        post(
          args,
          path.startsWith("/worker") ? claimed.jobToken : serviceSecret,
        ),
      );
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(await response.json()).toEqual({
        error: path.startsWith("/worker")
          ? "WORKER_REJECTED"
          : "REQUEST_REJECTED",
      });
    }
    expect(
      (
        await t.fetch("/worker/heartbeat", {
          ...post({}, claimed.jobToken),
          body: "{",
        })
      ).status,
    ).toBe(400);
    expect(await t.run((ctx) => ctx.db.get(jobId))).toEqual(before);
    expect(await t.run((ctx) => ctx.db.get(runId))).toMatchObject({
      status: "running",
    });
  });
});

test("subject retrack reads prior completed prerequisites and projected turns/remarks, without inventing missing outputs", async () => {
  const context = await running();
  const { t, coach, jobId, sessionId, coachId, claimed } = context;
  const run = await start(context);
  expect(
    (
      await t.fetch(
        "/worker/stageRuns/finish",
        post(finishInput(run, sessionId), claimed.jobToken),
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await t.fetch(
        "/worker/done",
        post({ status: "waiting_for_coach" }, claimed.jobToken),
      )
    ).status,
  ).toBe(200);
  await coach.mutation(api.sessions.setSubject, {
    sessionId,
    ...data.subject,
    point: { x: 0.5, y: 0.5 },
    role: "batter",
  });
  const next = await claim(t);
  expect(next.job.kind).toBe("subject_retrack");
  await t.run(async (ctx) => {
    await ctx.db.insert("remarks", {
      ...data.remark,
      sessionId,
      coachId,
      source: "voice",
      aboutSubject: "yes",
      kind: "feedback",
      mode: "tracked",
      status: "pending",
    });
    await ctx.db.insert("transcriptTurns", {
      sessionId,
      coachId,
      turnId: data.remark.turnIds[0],
      startMs: 0,
      endMs: 1000,
      speaker: data.identity.subject,
      text: data.annotation.why,
    });
  });
  const response = await t.fetch("/worker/job", {
    headers: headers(next.jobToken),
  });
  expect(response.status).toBe(200);
  const wire = await response.json();
  expect(wire.inputs.completedStageRuns).toHaveLength(1);
  expect(wire.inputs.completedStageRuns[0]).toMatchObject({
    jobId,
    stageRunId: run,
    stage: "transcode",
  });
  expect(wire.inputs.remarks).toHaveLength(1);
  expect(wire.inputs.remarks[0]).toMatchObject(data.remark);
  expect(wire.inputs.transcriptTurns[0]).toEqual({
    turnId: data.remark.turnIds[0],
    startMs: 0,
    endMs: 1000,
    speaker: data.identity.subject,
    text: data.annotation.why,
    correctedText: null,
  });
  expect(JSON.stringify(wire)).not.toContain('"_id"');
  expect(JSON.stringify(wire)).not.toContain('"coachId"');
  expect(
    (
      await t.fetch(
        "/svc/jobs/fail",
        post({ jobId, errorCode: "SANDBOX_LOST" }),
      )
    ).status,
  ).toBe(200);
  expect(await t.run((ctx) => ctx.db.get(sessionId))).toMatchObject({
    status: "processing",
    latestJobId: next.job.id,
  });
  expect(await t.run((ctx) => ctx.db.get(next.job.id))).toMatchObject({
    status: "running",
  });
});

test("expired worker token denies every route even while the database lease is live", async () => {
  const context = await running();
  const run = await start(context);
  const token = await signJobToken(
    { jobId: context.jobId, sessionId: context.sessionId, exp: Date.now() },
    workerSecret,
  );
  const before = await context.t.run((ctx) => ctx.db.get(context.jobId));
  for (const path of workerPaths)
    expect((await workerCall(context, path, token, run)).status).toBe(401);
  expect(await context.t.run((ctx) => ctx.db.get(context.jobId))).toEqual(
    before,
  );
});

test("service failure is not a worker completion replay", async () => {
  const { t, jobId, sessionId, claimed } = await running();
  expect(
    (
      await t.fetch(
        "/svc/jobs/fail",
        post({ jobId, errorCode: "SANDBOX_LOST" }),
      )
    ).status,
  ).toBe(200);
  const before = await t.run((ctx) => ctx.db.get(jobId));
  expect(before).toMatchObject({ status: "failed", errorCode: "SANDBOX_LOST" });
  expect(
    (
      await t.fetch(
        "/worker/done",
        post({ status: "failed", errorCode: "SANDBOX_LOST" }, claimed.jobToken),
      )
    ).status,
  ).toBe(403);
  expect(await t.run((ctx) => ctx.db.get(jobId))).toEqual(before);
  expect(await t.run((ctx) => ctx.db.get(sessionId))).toMatchObject({
    status: "failed",
  });
});

test("reclaim clears old completion/error fields and a successful done retry remains exact", async () => {
  const { t, jobId, claimed } = await running();
  expect(
    (
      await t.fetch(
        "/worker/done",
        post({ status: "failed", errorCode: "INFRA_EXEC" }, claimed.jobToken),
      )
    ).status,
  ).toBe(200);
  await t.run((ctx) => ctx.db.patch(jobId, { status: "queued" }));
  const next = await claim(t);
  const reclaimed = await t.run((ctx) => ctx.db.get(jobId));
  expect(reclaimed?.errorCode).toBeUndefined();
  expect(reclaimed?.endedAt).toBeUndefined();
  expect(
    (await t.fetch("/worker/done", post({ status: "done" }, next.jobToken)))
      .status,
  ).toBe(200);
  expect(
    (await t.fetch("/worker/done", post({ status: "done" }, next.jobToken)))
      .status,
  ).toBe(200);
  expect(await t.run((ctx) => ctx.db.get(jobId))).toMatchObject({
    status: "done",
    attempt: 2,
  });
});

test("failed stage finish, ordered retry and immutable start metadata persist usage once each", async () => {
  const context = await running();
  const { t, jobId, sessionId, claimed } = context;
  const run = await start(context);
  const failed = {
    ...finishInput(run, sessionId),
    status: "failed",
    outputRef: undefined,
    errorCode: "VIDEO_DECODE",
  };
  expect(
    (await t.fetch("/worker/stageRuns/finish", post(failed, claimed.jobToken)))
      .status,
  ).toBe(200);
  expect(
    (await t.fetch("/worker/stageRuns/finish", post(failed, claimed.jobToken)))
      .status,
  ).toBe(200);
  const retry = await t.fetch(
    "/worker/stageRuns/start",
    post({ ...startInput(), attempt: 2 }, claimed.jobToken),
  );
  expect(retry.status).toBe(200);
  const id: Id<"stageRuns"> = (await retry.json()).stageRunId;
  expect(id).not.toBe(run);
  expect(
    (
      await t.fetch(
        "/worker/stageRuns/finish",
        post(finishInput(id, sessionId), claimed.jobToken),
      )
    ).status,
  ).toBe(200);
  expect(await t.run((ctx) => ctx.db.get(jobId))).toMatchObject({
    samFrames: 10,
    inputTokens: 20,
    outputTokens: 4,
    costUsd: 0.02,
  });
  expect(
    (
      await t.fetch(
        "/worker/stageRuns/start",
        post(
          { ...startInput(), attempt: 2, promptHash: data.run.inputHash },
          claimed.jobToken,
        ),
      )
    ).status,
  ).toBe(403);
  expect(
    await t.run((ctx) => ctx.db.query("stageRuns").collect()),
  ).toHaveLength(2);
});

test("guarded local failure rechecks owner, attempt and fresh heartbeat atomically", async () => {
  const c = await running();
  const input = {
    jobId: c.jobId,
    errorCode: "INFRA_EXEC",
    leaseOwner: c.claimed.job.leaseOwner,
    expectedAttempt: c.claimed.job.attempt,
    staleOnly: true,
  };
  const fail = () => c.t.fetch("/svc/jobs/fail", post(input));
  expect((await fail()).status).toBe(200);
  expect((await c.t.run((ctx) => ctx.db.get(c.jobId)))?.status).toBe("running");
  await c.t.run((ctx) =>
    ctx.db.patch(c.jobId, { leaseOwner: crypto.randomUUID(), leaseUntil: 0 }),
  );
  expect((await fail()).status).toBe(200);
  expect((await c.t.run((ctx) => ctx.db.get(c.jobId)))?.status).toBe("running");
  await c.t.run((ctx) =>
    ctx.db.patch(c.jobId, {
      leaseOwner: input.leaseOwner,
      attempt: input.expectedAttempt + 1,
    }),
  );
  expect((await fail()).status).toBe(200);
  expect((await c.t.run((ctx) => ctx.db.get(c.jobId)))?.status).toBe("running");
  await c.t.run((ctx) =>
    ctx.db.patch(c.jobId, { attempt: input.expectedAttempt }),
  );
  expect((await fail()).status).toBe(200);
  expect((await c.t.run((ctx) => ctx.db.get(c.jobId)))?.status).toBe("failed");
});

test("guarded sandbox registration rejects a changed claim owner", async () => {
  const c = await running();
  await c.t.run((ctx) =>
    ctx.db.patch(c.jobId, { leaseOwner: crypto.randomUUID() }),
  );
  expect(
    (
      await c.t.fetch(
        "/svc/jobs/sandbox",
        post({
          jobId: c.jobId,
          sandboxId: crypto.randomUUID(),
          sandboxName: crypto.randomUUID(),
          driver: "local",
          leaseOwner: c.claimed.job.leaseOwner,
          expectedAttempt: c.claimed.job.attempt,
        }),
      )
    ).status,
  ).toBe(400);
  expect(await c.t.run((ctx) => ctx.db.query("sandboxes").collect())).toEqual(
    [],
  );
});

test("owned control returns closed transactional decisions after heartbeat refresh", async () => {
  const c = await running();
  const input = {
    jobId: c.jobId,
    leaseOwner: c.claimed.job.leaseOwner,
    expectedAttempt: c.claimed.job.attempt,
  };
  const control = async () =>
    (await c.t.fetch("/svc/jobs/control", post(input))).json();
  await c.t.run((ctx) => ctx.db.patch(c.jobId, { heartbeatAt: 0 }));
  const snapshot = await c.t.fetch("/svc/jobs/stale", {
    headers: { Authorization: `Bearer ${process.env.CONVEX_SERVICE_SECRET}` },
  });
  expect(
    (await snapshot.json()).some((j: { _id: string }) => j._id === c.jobId),
  ).toBe(true);
  await c.t.run((ctx) =>
    ctx.db.patch(c.jobId, {
      heartbeatAt: Date.now(),
      leaseUntil: Date.now() + 60000,
    }),
  );
  expect(await control()).toEqual({ decision: "continue" });
  expect((await c.t.run((ctx) => ctx.db.get(c.jobId)))?.status).toBe("running");
  await c.t.run((ctx) =>
    ctx.db.patch(c.jobId, { leaseOwner: "successor", heartbeatAt: 0 }),
  );
  expect(await control()).toEqual({ decision: "superseded" });
  expect((await c.t.run((ctx) => ctx.db.get(c.jobId)))?.status).toBe("running");
  await c.t.run((ctx) =>
    ctx.db.patch(c.jobId, { leaseOwner: input.leaseOwner }),
  );
  expect(await control()).toEqual({ decision: "stopped" });
  expect((await c.t.run((ctx) => ctx.db.get(c.jobId)))?.status).toBe("failed");
  expect(await control()).toEqual({ decision: "terminal" });
});
