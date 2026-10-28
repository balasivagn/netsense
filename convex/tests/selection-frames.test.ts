import { expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import { setup, tap, data } from "./helpers";

test("selection source read is authenticated/owned, complete-only and never enqueues", async () => {
  const h = await setup();
  const args = { sessionId: h.sessionId };
  await h.t.run((ctx) =>
    ctx.db.patch(h.uploadId, {
      storageKey: `sessions/${h.sessionId}/source/original`,
      bytesConfirmed: data.upload.bytesTotal,
    }),
  );
  await expect(h.t.query(api.selectionFrames.source, args)).rejects.toThrow(
    "UNAUTHENTICATED",
  );
  await expect(h.other.query(api.selectionFrames.source, args)).rejects.toThrow(
    "NOT_FOUND",
  );
  await expect(h.coach.query(api.selectionFrames.source, args)).rejects.toThrow(
    "SOURCE_UNAVAILABLE",
  );
  await h.t.mutation(internal.uploads.complete, {
    uploadId: h.uploadId,
    coachId: h.coachId,
    verifiedBytes: data.upload.bytesTotal,
  });
  expect(await h.coach.query(api.selectionFrames.source, args)).toEqual({
    key: `sessions/${h.sessionId}/source/original`,
    bytes: data.upload.bytesTotal,
    sha256: data.upload.sha256,
  });
  await h.t.run(async (ctx) => {
    expect(await ctx.db.query("jobs").collect()).toEqual([]);
    expect(await ctx.db.query("stageRuns").collect()).toEqual([]);
  });
  const job = await h.coach.mutation(api.sessions.setSubject, {
    ...args,
    ...tap,
  });
  expect(job).toBeTruthy();
  expect(
    await h.coach.mutation(api.sessions.setSubject, { ...args, ...tap }),
  ).toBe(job);
  expect(await h.t.run((ctx) => ctx.db.query("jobs").collect())).toHaveLength(
    1,
  );
});

test("completed-source query refuses inconsistent metadata, abort and missing consent", async () => {
  const h = await setup();
  const key = `sessions/${h.sessionId}/source/original`;
  await h.t.run((ctx) =>
    ctx.db.patch(h.uploadId, {
      storageKey: key,
      bytesConfirmed: data.upload.bytesTotal,
    }),
  );
  await h.t.mutation(internal.uploads.complete, {
    uploadId: h.uploadId,
    coachId: h.coachId,
    verifiedBytes: data.upload.bytesTotal,
  });
  const original = await h.t.run((ctx) => ctx.db.get(h.uploadId));
  for (const patch of [
    { storageKey: `sessions/${h.sessionId}/proxy/video.mp4` },
    { driver: "r2" as const },
    { sha256: "invalid" },
    { bytesTotal: 2 * 1024 ** 3 + 1 },
    { bytesConfirmed: 0 },
    { status: "aborted" as const },
    { phase: "aborting" as const },
  ]) {
    await h.t.run((ctx) => ctx.db.patch(h.uploadId, patch));
    await expect(
      h.coach.query(api.selectionFrames.source, { sessionId: h.sessionId }),
    ).rejects.toThrow("SOURCE_UNAVAILABLE");
    await h.t.run((ctx) => ctx.db.patch(h.uploadId, original!));
  }
  await h.t.run((ctx) =>
    ctx.db.patch(h.sessionId, { consentConfirmedAt: undefined }),
  );
  await expect(
    h.coach.query(api.selectionFrames.source, { sessionId: h.sessionId }),
  ).rejects.toThrow("CONSENT_REQUIRED");
});
