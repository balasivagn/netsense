import { expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import { setup, ready, tap, data } from "./helpers";
for (const order of ["upload-first", "subject-first", "concurrent"] as const)
  test(`exactly one pipeline: ${order} and repeated triggers`, async () => {
    const { t, coach, sessionId, uploadId, coachId } = await setup();
    const complete = () =>
      t.mutation(internal.uploads.complete, {
        uploadId,
        coachId,
        verifiedBytes: data.upload.bytesTotal,
      });
    const select = () =>
      coach.mutation(api.sessions.setSubject, { sessionId, ...tap });
    if (order === "upload-first") {
      expect(await complete()).toBeNull();
      await select();
    } else if (order === "subject-first") {
      expect(await select()).toBeNull();
      await complete();
    } else await Promise.all([complete(), select()]);
    await Promise.all([
      complete(),
      select(),
      t.mutation(internal.jobs.enqueueWhenReady, { sessionId }),
      complete(),
    ]);
    const jobs = await t.run((ctx) => ctx.db.query("jobs").collect());
    expect(jobs).toHaveLength(1);
    expect(jobs[0].kind).toBe("pipeline");
    expect(jobs[0].configVersion).toBe(1);
  });
test("failed/paused upload and absent subject do not enqueue", async () => {
  const { t, coach, sessionId, uploadId } = await setup();
  expect(
    await t.mutation(internal.jobs.enqueueWhenReady, { sessionId }),
  ).toBeNull();
  await coach.mutation(api.sessions.setSubject, { sessionId, ...tap });
  await t.run((ctx) => ctx.db.patch(uploadId, { status: "paused" }));
  expect(
    await t.mutation(internal.jobs.enqueueWhenReady, { sessionId }),
  ).toBeNull();
  await t.run((ctx) => ctx.db.patch(uploadId, { status: "failed" }));
  expect(
    await t.mutation(internal.jobs.enqueueWhenReady, { sessionId }),
  ).toBeNull();
});
test("subject validations reject coordinates, timing, and inconsistent role", async () => {
  const { t, coach, sessionId } = await setup();
  await t.run((ctx) => ctx.db.patch(sessionId, { durationMs: 2000 }));
  for (const change of [
    { point: { x: -0.1, y: 0.5 } },
    { point: { x: 0.5, y: 1.1 } },
    { point: { x: NaN, y: 0.5 } },
    { frameMs: -1 },
    { frameMs: 0.5 },
    { frameMs: 2001 },
    { role: "bowler" as const },
  ])
    await expect(
      coach.mutation(api.sessions.setSubject, { sessionId, ...tap, ...change }),
    ).rejects.toThrow("INVALID_SUBJECT");
  await coach.mutation(api.sessions.setSubject, {
    sessionId,
    ...tap,
    frameMs: 2000,
    point: { x: 0, y: 1 },
  });
  expect(
    (await coach.query(api.sessions.get, { sessionId })).subject?.point,
  ).toEqual({ x: 0, y: 1 });
});
test("queued tap updates without a second job; running change fails atomically", async () => {
  const { t, coach, sessionId, jobId } = await ready();
  await coach.mutation(api.sessions.setSubject, {
    sessionId,
    ...tap,
    frameMs: 1500,
  });
  expect(await t.run((ctx) => ctx.db.query("jobs").collect())).toHaveLength(1);
  await t.mutation(internal.jobs.claim, { leaseOwner: data.leaseOwner });
  await expect(
    coach.mutation(api.sessions.setSubject, { sessionId, ...tap }),
  ).rejects.toThrow("JOB_IN_PROGRESS");
  expect(
    (await coach.query(api.sessions.get, { sessionId })).subject?.frameMs,
  ).toBe(1500);
  expect((await t.run((ctx) => ctx.db.get(jobId)))?.status).toBe("running");
});
test("subject retrack resets AI approval and anchor, preserves coach and deleted marks", async () => {
  const { t, coach, sessionId, coachId, jobId } = await ready();
  const marks = await t.run(async (ctx) => {
    await ctx.db.patch(jobId, { status: "waiting_for_coach" });
    await ctx.db.patch(sessionId, {
      subjectStatus: "anchored",
      subjectAnchor: data.anchor,
    });
    const base = {
      ...data.annotation,
      sessionId,
      coachId,
      markType: "circle" as const,
      anchor: "box_center" as const,
      role: "batter" as const,
      status: "approved" as const,
      placedBy: "ai" as const,
      provenance: { ...data.annotation.provenance, placedBy: "ai" as const },
    };
    return [
      await ctx.db.insert("annotations", base),
      await ctx.db.insert("annotations", {
        ...base,
        placedBy: "coach",
        provenance: { ...base.provenance, placedBy: "coach" },
      }),
      await ctx.db.insert("annotations", { ...base, status: "deleted" }),
    ];
  });
  const retrack = await coach.mutation(api.sessions.setSubject, {
    sessionId,
    ...tap,
    frameMs: 1500,
  });
  expect((await t.run((ctx) => ctx.db.get(retrack!)))?.kind).toBe(
    "subject_retrack",
  );
  const stored = await t.run((ctx) =>
    Promise.all(marks.map((id) => ctx.db.get(id))),
  );
  expect(stored.map((m) => m?.status)).toEqual([
    "needs_you",
    "approved",
    "deleted",
  ]);
  expect(stored[0]?.approvedAt).toBeUndefined();
  expect(stored[1]?.approvedAt).toBe(1);
  const session = await coach.query(api.sessions.get, { sessionId });
  expect(session.subjectAnchor).toBeUndefined();
  expect(session.subjectStatus).toBe("set");
  await coach.mutation(api.sessions.setSubject, {
    sessionId,
    ...tap,
    frameMs: 1500,
  });
  expect(await t.run((ctx) => ctx.db.query("jobs").collect())).toHaveLength(2);
});
test("upload completion verifies owner, size, state and duration before enqueue", async () => {
  const { t, coach, other, sessionId, uploadId, coachId } = await setup();
  const otherId = await other.mutation(api.coaches.ensure, {});
  await expect(
    t.mutation(internal.uploads.complete, {
      uploadId,
      coachId: otherId,
      verifiedBytes: 1024,
    }),
  ).rejects.toThrow("NOT_FOUND");
  await expect(
    t.mutation(internal.uploads.complete, {
      uploadId,
      coachId,
      verifiedBytes: 1,
    }),
  ).rejects.toThrow("UPLOAD_SIZE_MISMATCH");
  await coach.mutation(api.sessions.setSubject, { sessionId, ...tap });
  await expect(
    t.mutation(internal.uploads.complete, {
      uploadId,
      coachId,
      verifiedBytes: 1024,
      durationMs: 999,
    }),
  ).rejects.toThrow("INVALID_DURATION");
  await t.run((ctx) => ctx.db.patch(uploadId, { status: "aborted" }));
  await expect(
    t.mutation(internal.uploads.complete, {
      uploadId,
      coachId,
      verifiedBytes: 1024,
    }),
  ).rejects.toThrow("INVALID_UPLOAD_STATE");
  expect(await t.run((ctx) => ctx.db.query("jobs").collect())).toHaveLength(0);
});

test("the same tap may retry after an anchor failure", async () => {
  const { t, coach, sessionId, jobId } = await ready();
  await t.run(async (ctx) => {
    await ctx.db.patch(jobId, {
      status: "waiting_for_coach",
      errorCode: "SUBJECT_NEEDED",
    });
    await ctx.db.patch(sessionId, { subjectStatus: "anchor_failed" });
  });
  const retrack = await coach.mutation(api.sessions.setSubject, {
    sessionId,
    ...tap,
  });
  expect((await t.run((ctx) => ctx.db.get(retrack!)))?.kind).toBe(
    "subject_retrack",
  );
});
