import { expect, test } from "vitest";
import { api } from "../_generated/api";
import { reviewReady } from "./reviewHelpers";

test("actual persisted pipeline projects only owned coach-safe joins and current preview", async () => {
  const c = await reviewReady();
  expect(c.view.preview?.fileRef).toBe(c.f.render.fileRef);
  expect(c.view.remarks[0].words).toBe(c.f.plan.remarks[0].coachWords);
  expect(c.view.artifact).toContain(c.runs.transcode);
  await expect(
    c.other.query(api.playback.get, { sessionId: c.sessionId }),
  ).rejects.toThrow("NOT_FOUND");
  await expect(
    c.t.query(api.playback.get, { sessionId: c.sessionId }),
  ).rejects.toThrow("UNAUTHENTICATED");
  expect(JSON.stringify(c.view)).not.toMatch(
    /modelVersion|inputTokens|leaseOwner|promptHash/,
  );
  await c.coach.mutation(api.review.delete, { annotationId: c.id });
  expect(
    (await c.coach.query(api.playback.get, { sessionId: c.sessionId })).preview,
  ).toBeNull();
  await c.coach.mutation(api.review.undoDelete, { annotationId: c.id });
  expect(
    (await c.coach.query(api.playback.get, { sessionId: c.sessionId }))
      .annotations[0].status,
  ).toBe("needs_you");
});
test("one-item approval, foreign/unauthed denial, immutable originals and correction separation", async () => {
  const c = await reviewReady();
  await expect(
    c.other.mutation(api.review.approve, { annotationId: c.id }),
  ).rejects.toThrow("NOT_FOUND");
  await expect(
    c.t.mutation(api.review.approve, { annotationId: c.id }),
  ).rejects.toThrow("UNAUTHENTICATED");
  // Closed validators reject an array in place of the single ID.
  await expect(
    c.coach.mutation(api.review.approve, {
      annotationId: [c.id] as unknown as typeof c.id,
    }),
  ).rejects.toThrow();
  await c.coach.mutation(api.review.approve, { annotationId: c.id });
  const before = await c.t.run((ctx) => ctx.db.get(c.id));
  expect(before?.status).toBe("approved");
  const turn = c.view.remarks[0].turns[0];
  await c.coach.mutation(api.review.correctTurn, {
    sessionId: c.sessionId,
    turnId: turn.id,
    correctedText: turn.text + " ",
  });
  const after = await c.coach.query(api.playback.get, {
    sessionId: c.sessionId,
  });
  expect(after.remarks[0].words).toBe(c.view.remarks[0].words);
  expect(after.remarks[0].turns[0].correctedText).toBe(turn.text + " ");
  await c.coach.mutation(api.review.move, {
    annotationId: c.id,
    anchor: "box_top",
    startMs: before!.startMs,
    endMs: before!.endMs,
  });
  const moved = await c.t.run((ctx) => ctx.db.get(c.id));
  expect(moved?.aiPlacement).toEqual(before?.aiPlacement);
  expect(moved?.provenance).toEqual(before?.provenance);
  expect(moved).toMatchObject({ placedBy: "coach", status: "needs_you" });
});
test("invalid times, role, track, checked failure and invented labels reject transactionally", async () => {
  const c = await reviewReady();
  const a = (await c.t.run((ctx) => ctx.db.get(c.id)))!;
  for (const patch of [
    { startMs: NaN },
    { startMs: -1 },
    { endMs: a.startMs },
    { endMs: 2001 },
    { role: "bowler" as const },
    { trackId: "missing" },
    { checkVerdict: { pass: false, reason: "subject_swap" as const } },
  ]) {
    await c.t.run((ctx) => ctx.db.patch(c.id, patch));
    await expect(
      c.coach.mutation(api.review.approve, { annotationId: c.id }),
    ).rejects.toThrow();
    await c.t.run((ctx) =>
      ctx.db.patch(c.id, {
        startMs: a.startMs,
        endMs: a.endMs,
        role: a.role,
        trackId: a.trackId,
        checkVerdict: a.checkVerdict,
      }),
    );
  }
  await expect(
    c.coach.mutation(api.review.edit, {
      annotationId: c.id,
      markType: a.markType,
      anchor: a.anchor,
      startMs: a.startMs,
      endMs: a.endMs,
      neutralLabel: "Bowler",
    }),
  ).rejects.toThrow("INVALID_LABEL");
  await c.t.run((ctx) =>
    ctx.db.patch(c.id, { trackId: undefined, status: "player_missing" }),
  );
  await c.coach.mutation(api.review.edit, {
    annotationId: c.id,
    markType: a.markType,
    anchor: a.anchor,
    startMs: a.startMs,
    endMs: a.endMs,
    labelSpan: a.labelSpan,
    neutralLabel: a.neutralLabel,
    mode: "note_only",
  });
  await c.coach.mutation(api.review.approve, { annotationId: c.id });
  expect(
    (await c.coach.query(api.playback.get, { sessionId: c.sessionId }))
      .remarks[0].mode,
  ).toBe("note_only");
});

test("retime saves a single draft but cannot inherit approval from another checked range", async () => {
  const c = await reviewReady();
  const a = c.view.annotations[0];
  await c.coach.mutation(api.review.move, {
    annotationId: c.id,
    anchor: a.anchor,
    startMs: a.startMs + 1,
    endMs: a.endMs,
  });
  await expect(
    c.coach.mutation(api.review.approve, { annotationId: c.id }),
  ).rejects.toThrow("PLACEMENT_CHECK_REQUIRED");
  expect(
    (await c.coach.query(api.playback.get, { sessionId: c.sessionId }))
      .annotations[0].status,
  ).toBe("needs_you");
});
