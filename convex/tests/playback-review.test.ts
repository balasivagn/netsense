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

test("label source can change in both directions without retaining the old optional field", async () => {
  const c = await reviewReady();
  const original = (await c.t.run(ctx => ctx.db.get(c.id)))!;
  const fields = {
    annotationId: c.id, markType: original.markType, anchor: original.anchor,
    startMs: original.startMs, endMs: original.endMs,
  };
  await c.coach.mutation(api.review.edit, { ...fields, neutralLabel: "Batter" });
  const neutral = (await c.t.run(ctx => ctx.db.get(c.id)))!;
  expect(neutral.labelText).toBe("Batter");
  expect(neutral.labelSpan).toBeUndefined();
  await c.coach.mutation(api.review.edit, { ...fields, labelSpan: original.labelSpan });
  const restored = (await c.t.run(ctx => ctx.db.get(c.id)))!;
  expect(restored.labelText).toBe(original.labelText);
  expect(restored.neutralLabel).toBeUndefined();
  expect(restored.aiPlacement).toEqual(original.aiPlacement);
  expect(restored.provenance).toEqual(original.provenance);
});

test("changing a remark's placement mode clears every affected approval without approving siblings", async () => {
  const c = await reviewReady();
  const original = (await c.t.run(ctx => ctx.db.get(c.id)))!;
  const sibling = await c.t.run(async ctx => {
    const { _id, _creationTime, ...fields } = original;
    void _id; void _creationTime;
    return ctx.db.insert("annotations", { ...fields, markId: original.markId + "-second" });
  });
  await c.coach.mutation(api.review.approve, { annotationId: c.id });
  await c.coach.mutation(api.review.approve, { annotationId: sibling });
  await c.coach.mutation(api.review.edit, {
    annotationId: c.id, markType: original.markType, anchor: original.anchor,
    startMs: original.startMs, endMs: original.endMs, labelSpan: original.labelSpan,
    mode: "note_only",
  });
  const marks = await c.t.run(ctx => ctx.db.query("annotations").collect());
  expect(marks).toHaveLength(2);
  for (const mark of marks) {
    expect(mark.status).toBe("needs_you");
    expect(mark.approvedAt).toBeUndefined();
  }
  expect(marks.find(mark => mark._id === c.id)?.placedBy).toBe("coach");
  await c.coach.mutation(api.review.approve, { annotationId: c.id });
  expect((await c.t.run(ctx => ctx.db.get(sibling)))?.status).toBe("needs_you");
});
