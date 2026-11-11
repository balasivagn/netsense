import { afterEach, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import { running } from "./persistenceHelpers";
import { data } from "./helpers";

async function prepared() {
  const c = await running();
  await c.step("transcode", "transcode");
  await c.step("transcribe", "turns");
  await c.step("plan", "plan");
  await c.t.run((ctx) =>
    ctx.db.patch(c.jobId, { status: "waiting_for_coach" }),
  );
  const view = await c.coach.query(api.lessons.get, { sessionId: c.sessionId });
  return { ...c, view };
}

test("lesson projection is owner-scoped and exposes only Screen 21 data", async () => {
  const c = await prepared();
  expect(c.view).toMatchObject({
    ownerUserId: data.identity.subject,
    practiceEnabled: true,
    focusPoints: [
      { id: "synthetic-focus", source: "ai_draft", approved: false },
    ],
  });
  expect(JSON.stringify(c.view)).not.toMatch(/config|model|trace|tombstone/i);
  await expect(
    c.other.query(api.lessons.get, { sessionId: c.sessionId }),
  ).rejects.toThrow("NOT_FOUND");
  await expect(
    c.t.query(api.lessons.get, { sessionId: c.sessionId }),
  ).rejects.toThrow("UNAUTHENTICATED");
});

test("single-item actions isolate approval and retain AI origin and why after edit", async () => {
  const c = await prepared();
  const original = c.view.focusPoints[0];
  const approved = await c.coach.mutation(api.lessons.update, {
    sessionId: c.sessionId,
    expectedRevision: c.view.revision,
    action: { kind: "approveFocus", id: original.id },
  });
  let view = await c.coach.query(api.lessons.get, { sessionId: c.sessionId });
  expect(view.focusPoints).toEqual([{ ...original, approved: true }]);
  const edited = await c.coach.mutation(api.lessons.update, {
    sessionId: c.sessionId,
    expectedRevision: approved.revision,
    action: {
      kind: "editFocus",
      id: original.id,
      title: "Coach-edited synthetic focus",
      remarkIds: ["synthetic-r1"],
    },
  });
  view = await c.coach.query(api.lessons.get, { sessionId: c.sessionId });
  expect(view.focusPoints[0]).toMatchObject({
    source: "ai_draft",
    why: original.why,
    approved: true,
    editedByCoach: true,
    title: "Coach-edited synthetic focus",
  });
  const originalNote = view.notes[0];
  const noteEdited = await c.coach.mutation(api.lessons.update, {
    sessionId: c.sessionId,
    expectedRevision: edited.revision,
    action: {
      kind: "editNote",
      noteIndex: 0,
      text: "Coach-edited synthetic note",
    },
  });
  view = await c.coach.query(api.lessons.get, { sessionId: c.sessionId });
  expect(view.notes[0]).toMatchObject({
    source: "ai_draft",
    why: originalNote.why,
    approved: false,
    text: "Coach-edited synthetic note",
  });
  const beforeDuplicate = await c.t.run((ctx) =>
    ctx.db.query("lessons").unique(),
  );
  await expect(
    c.coach.mutation(api.lessons.update, {
      sessionId: c.sessionId,
      expectedRevision: noteEdited.revision,
      action: { kind: "approveFocus", id: original.id },
    }),
  ).rejects.toThrow("INVALID_ACTION");
  expect(await c.t.run((ctx) => ctx.db.query("lessons").unique())).toEqual(
    beforeDuplicate,
  );
  const turn = await c.t.run((ctx) =>
    ctx.db
      .query("transcriptTurns")
      .withIndex("by_sessionId_turnId", (q) =>
        q.eq("sessionId", c.sessionId).eq("turnId", "synthetic-t1"),
      )
      .unique(),
  );
  expect(turn?.text).toBe(c.f.plan.remarks[0].coachWords);
  expect(noteEdited.revision).toBe(view.revision);
});

test("stale, duplicate, malformed and busy mutations reject without writes", async () => {
  const c = await prepared();
  const before = await c.t.run((ctx) => ctx.db.query("lessons").unique());
  await expect(
    c.coach.mutation(api.lessons.update, {
      sessionId: c.sessionId,
      expectedRevision: "stale",
      action: { kind: "approveFocus", id: "synthetic-focus" },
    }),
  ).rejects.toThrow("LESSON_CONFLICT");
  await expect(
    c.coach.mutation(api.lessons.update, {
      sessionId: c.sessionId,
      expectedRevision: c.view.revision,
      action: {
        kind: "addFocus",
        id: "synthetic-focus",
        title: "Valid synthetic coach item",
        remarkIds: ["synthetic-r1"],
      },
    }),
  ).rejects.toThrow("DUPLICATE_ID");
  await expect(
    c.coach.mutation(api.lessons.update, {
      sessionId: c.sessionId,
      expectedRevision: c.view.revision,
      action: {
        kind: "addFocus",
        id: "bad id",
        title: "",
        remarkIds: ["missing-remark"],
      },
    }),
  ).rejects.toThrow();
  expect(await c.t.run((ctx) => ctx.db.query("lessons").unique())).toEqual(
    before,
  );
  await c.t.run((ctx) => ctx.db.patch(c.jobId, { status: "running" }));
  await expect(
    c.coach.mutation(api.lessons.update, {
      sessionId: c.sessionId,
      expectedRevision: c.view.revision,
      action: { kind: "approveFocus", id: "synthetic-focus" },
    }),
  ).rejects.toThrow("JOB_IN_PROGRESS");
});

test("parallel third-focus approvals never exceed two approved focus points", async () => {
  const c = await prepared();
  await c.t.run(async (ctx) => {
    const lesson = (await ctx.db.query("lessons").unique())!;
    await ctx.db.patch(lesson._id, {
      focusPoints: [
        ...lesson.focusPoints,
        {
          id: "synthetic-focus-approved",
          title: "Synthetic existing approved focus",
          why: "Synthetic rationale",
          remarkIds: ["synthetic-r1"],
          source: "ai_draft",
          approved: true,
          editedByCoach: false,
        },
        {
          id: "synthetic-focus-racing",
          title: "Synthetic racing focus",
          why: "Synthetic rationale",
          remarkIds: ["synthetic-r1"],
          source: "ai_draft",
          approved: false,
          editedByCoach: false,
        },
      ],
    });
  });
  const current = await c.coach.query(api.lessons.get, {
    sessionId: c.sessionId,
  });
  const approve = (id: string) =>
    c.coach.mutation(api.lessons.update, {
      sessionId: c.sessionId,
      expectedRevision: current.revision,
      action: { kind: "approveFocus", id },
    });
  const results = await Promise.allSettled([
    approve("synthetic-focus"),
    approve("synthetic-focus-racing"),
  ]);
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  const view = await c.coach.query(api.lessons.get, { sessionId: c.sessionId });
  expect(view.focusPoints.filter((item) => item.approved)).toHaveLength(2);
});

test("practice flag hides and rejects without erasing stored practice", async () => {
  const c = await prepared();
  const added = await c.coach.mutation(api.lessons.update, {
    sessionId: c.sessionId,
    expectedRevision: c.view.revision,
    action: {
      kind: "addPractice",
      id: "coach-practice-one",
      title: "Synthetic coach practice",
      remarkIds: ["synthetic-r1"],
    },
  });
  vi.stubEnv("FEATURE_PRACTICE_PLAN", "off");
  const hidden = await c.coach.query(api.lessons.get, {
    sessionId: c.sessionId,
  });
  expect(hidden).toMatchObject({ practiceEnabled: false, practice: [] });
  await expect(
    c.coach.mutation(api.lessons.update, {
      sessionId: c.sessionId,
      expectedRevision: added.revision,
      action: { kind: "approvePractice", id: "coach-practice-one" },
    }),
  ).rejects.toThrow("PRACTICE_DISABLED");
  expect(
    (await c.t.run((ctx) => ctx.db.query("lessons").unique()))?.practice,
  ).toHaveLength(1);
  vi.unstubAllEnvs();
});

afterEach(() => vi.unstubAllEnvs());

test("dismissed AI drafts cannot resurrect on a persisted plan retry while preserved items remain", async () => {
  const c = await prepared();
  await c.t.run(async (ctx) => {
    const lesson = (await ctx.db.query("lessons").unique())!;
    await ctx.db.patch(lesson._id, {
      practice: [
        {
          id: "synthetic-practice",
          title: "Synthetic practice",
          why: "Synthetic rationale",
          remarkIds: ["synthetic-r1"],
          source: "ai_draft",
          approved: false,
          editedByCoach: false,
        },
      ],
    });
  });
  const initial = await c.coach.query(api.lessons.get, {
    sessionId: c.sessionId,
  });
  const dismissedFocus = await c.coach.mutation(api.lessons.update, {
    sessionId: c.sessionId,
    expectedRevision: initial.revision,
    action: { kind: "dismissFocus", id: "synthetic-focus" },
  });
  const dismissedNote = await c.coach.mutation(api.lessons.update, {
    sessionId: c.sessionId,
    expectedRevision: dismissedFocus.revision,
    action: { kind: "dismissNote", noteIndex: 0 },
  });
  const dismissedPractice = await c.coach.mutation(api.lessons.update, {
    sessionId: c.sessionId,
    expectedRevision: dismissedNote.revision,
    action: { kind: "dismissPractice", id: "synthetic-practice" },
  });
  const coachFocus = await c.coach.mutation(api.lessons.update, {
    sessionId: c.sessionId,
    expectedRevision: dismissedPractice.revision,
    action: {
      kind: "addFocus",
      id: "coach-focus-kept",
      title: "Synthetic retained coach focus",
      remarkIds: ["synthetic-r1"],
    },
  });
  await c.t.run((ctx) => ctx.db.patch(c.jobId, { status: "running" }));
  const retry = await c.start("plan");
  const output = structuredClone(c.f.plan) as unknown as {
    drafts: {
      focus: Array<{
        id: string;
        title: string;
        why: string;
        remarkIds: string[];
        source: "ai_draft";
        approved: false;
        editedByCoach: false;
      }>;
      practice: Array<{
        id: string;
        title: string;
        why: string;
        remarkIds: string[];
        source: "ai_draft";
        approved: false;
        editedByCoach: false;
      }>;
    };
  };
  output.drafts.focus.push({
    ...output.drafts.focus[0],
    id: "synthetic-focus-new",
    title: "Synthetic new draft",
  });
  output.drafts.practice.push({
    id: "synthetic-practice",
    title: "Synthetic practice",
    why: "Synthetic rationale",
    remarkIds: ["synthetic-r1"],
    source: "ai_draft",
    approved: false,
    editedByCoach: false,
  });
  expect((await c.persist("plan", retry, output)).status).toBe(200);
  await c.t.run((ctx) =>
    ctx.db.patch(c.jobId, { status: "waiting_for_coach" }),
  );
  const view = await c.coach.query(api.lessons.get, { sessionId: c.sessionId });
  expect(view.focusPoints.map((item) => item.id)).toEqual([
    "coach-focus-kept",
    "synthetic-focus-new",
  ]);
  expect(view.notes).toEqual([]);
  expect(view.practice).toEqual([]);
  expect(view.focusPoints[0]).toMatchObject({
    source: "coach",
    approved: true,
  });
  expect(coachFocus.revision).toBe(view.revision);
});
