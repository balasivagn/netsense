import { expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import { setup, ready, tap, data } from "./helpers";

test("owner projections isolate foreign IDs and omit private configuration and job fields", async () => {
  const { t, coach, other, sessionId, jobId } = await ready();
  expect(await other.query(api.coachSessions.list, {})).toEqual([]);
  await expect(
    other.query(api.coachSessions.detail, { sessionId }),
  ).rejects.toThrow("NOT_FOUND");
  await expect(
    t.query(api.coachSessions.detail, { sessionId }),
  ).rejects.toThrow("UNAUTHENTICATED");
  const row = await coach.query(api.coachSessions.detail, { sessionId });
  expect(row.studentLabel).toBe(data.studentLabel);
  expect(row.upload?.complete).toBe(true);
  expect(row.job?.id).toBe(jobId);
  expect(
    Object.keys(row.job!).every((key) =>
      [
        "coachStage",
        "coachStages",
        "errorCode",
        "id",
        "progress",
        "progressLabel",
        "status",
      ].includes(key),
    ),
  ).toBe(true);
  expect(row.job).not.toHaveProperty("leaseOwner");
  expect(row.job).not.toHaveProperty("stages");
  await t.run(async (ctx) => {
    const config = await ctx.db.query("pipeline_config").first();
    await ctx.db.patch(config!._id, { active: false });
    const { _id: _ignored, _creationTime: _alsoIgnored, ...fields } = config!;
    void _ignored;
    void _alsoIgnored;
    await ctx.db.insert("pipeline_config", {
      ...fields,
      version: 2,
      active: true,
      coachStages: [...fields.coachStages].reverse(),
    });
    await ctx.db.patch(jobId, {
      progress: 0.5,
      progressLabel: row.job!.coachStage,
      status: "running",
    });
  });
  const updated = await coach.query(api.coachSessions.detail, { sessionId });
  expect(updated.job?.coachStages).toEqual(row.job?.coachStages);
  expect(updated.job?.status).toBe("running");
  expect(updated.job?.progress).toBe(0.5);
  const otherStudent = await other.mutation(api.students.add, {
    label: data.studentLabel,
  });
  const otherSession = await other.mutation(api.sessions.create, {
    studentId: otherStudent,
    subjectRole: "other",
  });
  await t.run((ctx) => ctx.db.patch(otherSession, { latestJobId: jobId }));
  expect(
    (await other.query(api.coachSessions.detail, { sessionId: otherSession }))
      .job,
  ).toBeNull();
});

test("draft omits capture mode; owner selects it before upload; old callers remain compatible", async () => {
  const { coach, other, t, studentId, coachId } = await setup();
  const sessionId = await coach.mutation(api.sessions.create, {
    studentId,
    subjectRole: "batter",
  });
  expect(
    (await coach.query(api.sessions.get, { sessionId })).captureMode,
  ).toBeUndefined();
  await coach.mutation(api.sessions.confirmConsent, { sessionId });
  const reserve = () =>
    t.mutation(internal.uploads.reserve, {
      sessionId,
      coachId,
      sha256: data.upload.sha256,
      mimeType: data.upload.mimeType,
      bytesTotal: data.upload.bytesTotal,
      multipartUploadId: "00000000-0000-4000-8000-000000000000",
    });
  await expect(reserve()).rejects.toThrow("CAPTURE_MODE_REQUIRED");
  await expect(
    other.mutation(api.sessions.selectCaptureMode, {
      sessionId,
      captureMode: "camera",
    }),
  ).rejects.toThrow("NOT_FOUND");
  await coach.mutation(api.sessions.selectCaptureMode, {
    sessionId,
    captureMode: "camera",
  });
  await reserve();
  await expect(
    coach.mutation(api.sessions.selectCaptureMode, {
      sessionId,
      captureMode: "camera_roll",
    }),
  ).rejects.toThrow("UPLOAD_CONFLICT");
  expect((await coach.query(api.sessions.get, { sessionId })).captureMode).toBe(
    "camera",
  );
});

test("whole-upload failures are durable, issued, owner-only and race-safe; complete wins late reports", async () => {
  const { coach, other, sessionId, t, uploadId, coachId } = await setup();
  const begin = () =>
    coach.mutation(api.coachSessions.beginAttempt, { sessionId });
  const fail = (attempt: number) =>
    coach.mutation(api.coachSessions.failAttempt, { sessionId, attempt });
  await expect(
    other.mutation(api.coachSessions.beginAttempt, { sessionId }),
  ).rejects.toThrow("NOT_FOUND");
  await expect(
    other.mutation(api.coachSessions.failAttempt, { sessionId, attempt: 1 }),
  ).rejects.toThrow("NOT_FOUND");
  await fail(100);
  expect(
    (await coach.query(api.coachSessions.detail, { sessionId })).uploadFailures,
  ).toBe(0);
  const first = await Promise.all([begin(), begin()]);
  expect(first[0]).toBe(first[1]);
  await Promise.all([fail(first[0]), fail(first[0])]);
  expect(
    (await coach.query(api.coachSessions.detail, { sessionId })).uploadFailures,
  ).toBe(1);
  const second = await begin();
  await fail(first[0]);
  await fail(second);
  const third = await begin();
  await fail(third);
  expect(
    (await coach.query(api.coachSessions.list, {}))[0].uploadFailures,
  ).toBe(3);
  await expect(begin()).rejects.toThrow("UPLOAD_FAILED");
  // An already admitted completion can recover; a late failure never counts it.
  await t.mutation(internal.uploads.complete, {
    uploadId,
    coachId,
    verifiedBytes: data.upload.bytesTotal,
  });
  await fail(third);
  expect(
    (await coach.query(api.coachSessions.detail, { sessionId })).upload
      ?.complete,
  ).toBe(true);
});
for (const tapFirst of [true, false])
  test(`coach projection observes both gates, tapFirst=${tapFirst}`, async () => {
    const { t, coach, coachId, sessionId, uploadId } = await setup();
    const select = () =>
      coach.mutation(api.sessions.setSubject, { sessionId, ...tap });
    const complete = () =>
      t.mutation(internal.uploads.complete, {
        uploadId,
        coachId,
        verifiedBytes: data.upload.bytesTotal,
      });
    expect(await (tapFirst ? select() : complete())).toBeNull();
    expect(
      (await coach.query(api.coachSessions.detail, { sessionId })).job,
    ).toBeNull();
    await (tapFirst ? complete() : select());
    await Promise.all([select(), complete()]);
    expect(
      (await coach.query(api.coachSessions.detail, { sessionId })).job?.status,
    ).toBe("queued");
    expect(await t.run((ctx) => ctx.db.query("jobs").collect())).toHaveLength(
      1,
    );
  });
