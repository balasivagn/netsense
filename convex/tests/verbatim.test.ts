import { expect, test } from "vitest";
import { running } from "./persistenceHelpers";
import { data } from "./helpers";
import type { Id } from "../_generated/dataModel";

test.each(["words", "turn", "atMs", "fanOut", "draft", "duplicate", "model"])(
  "plan %s violation rolls back every write and receipt",
  async (mode) => {
    const c = await running();
    await c.step("transcode", "transcode");
    await c.step("transcribe", "turns");
    const id = await c.start("plan");
    const o = structuredClone(c.f.plan);
    if (mode === "words") o.remarks[1].coachWords = data.annotation.why;
    if (mode === "turn") o.remarks[1].turnIds = ["foreign-turn"];
    if (mode === "atMs") o.remarks[1].atMs = 0;
    if (mode === "fanOut")
      o.fanOut.push({ ...o.fanOut[0], remarkId: o.remarks[1].remarkId });
    if (mode === "draft") o.drafts.focus[0].remarkIds = ["foreign-remark"];
    if (mode === "duplicate") o.remarks[1].turnIds = o.remarks[0].turnIds;
    const output =
      mode === "model"
        ? { coachSpeaker: data.identity.subject, remarks: o.remarks }
        : o;
    expect((await c.persist("plan", id, output)).status).toBe(403);
    expect(await c.t.run((ctx) => ctx.db.query("remarks").collect())).toEqual(
      [],
    );
    expect(await c.t.run((ctx) => ctx.db.query("lessons").collect())).toEqual(
      [],
    );
    expect(
      (await c.t.run((ctx) => ctx.db.get(id)))?.persistedOutputHash,
    ).toBeUndefined();
    expect((await c.persist("plan", id, c.f.plan)).status).toBe(200);
  },
);

test.each([
  "words",
  "wrong-turn",
  "utf16",
  "neutral-role",
  "neutral-number",
  "geometry",
  "type",
  "time",
  "duplicate",
  "span-length",
  "provenance-empty",
  "provenance-worker",
  "provenance-model",
  "provenance-config",
  "provenance-candidate",
  "provenance-run",
  "upstream-running",
  "foreign-track",
])("marks %s violation is atomic", async (mode) => {
  const c = await running();
  await c.base();
  const id = await c.start("place", "synthetic-r1"),
    p = await c.provenance(id),
    o = structuredClone(c.f.marks),
    m = o.marks[0];
  if (mode === "words") m.labelText = data.annotation.why;
  if (mode === "wrong-turn") m.labelSpan.turnId = "synthetic-t2";
  if (mode === "utf16") {
    m.labelSpan.start = 23;
    m.labelSpan.end = 24;
    m.labelText = "\udfcf";
  }
  if (mode === "neutral-role" || mode === "neutral-number")
    Object.assign(m, {
      labelSpan: null,
      neutralLabel: mode === "neutral-role" ? "Bowler" : "Remark",
      labelText: mode === "neutral-role" ? "Bowler" : "Remark 9",
    });
  if (mode === "geometry") Object.assign(m, { x: 10 });
  if (mode === "type") m.markType = "forbidden";
  if (mode === "time") m.endMs = 2000;
  if (mode === "duplicate") o.marks.push(m);
  if (mode === "span-length") m.labelSpan.end = 61;
  if (mode === "provenance-empty") p.stageRunIds = {};
  if (mode === "provenance-worker") p.workers.track = "forged";
  if (mode === "provenance-model") p.modelVersions.track = "forged";
  if (mode === "provenance-config") p.configVersion = 2;
  if (mode === "provenance-candidate")
    Object.assign(p, { candidate: "forged" });
  if (mode === "provenance-run") p.stageRunIds.track = c.runs.moment;
  if (mode === "upstream-running")
    await c.t.run((ctx) => ctx.db.patch(c.runs.track, { status: "running" }));
  if (mode === "foreign-track") {
    const track = await c.t.run((ctx) => ctx.db.query("tracks").unique());
    await c.t.run((ctx) =>
      ctx.db.patch(track!._id, { fileRef: "sessions/foreign/file.json" }),
    );
  }
  expect((await c.persist("marks", id, o, { provenance: p })).status).toBe(403);
  expect(await c.t.run((ctx) => ctx.db.query("annotations").collect())).toEqual(
    [],
  );
  expect(
    (await c.t.run((ctx) => ctx.db.get(id)))?.persistedOutputHash,
  ).toBeUndefined();
});

test("marks stable replay preserves coach changes, approves nothing, and rejects changed retry", async () => {
  const c = await running();
  await c.base();
  const id = await c.start("place", "synthetic-r1"),
    p = await c.provenance(id);
  const first = await (
    await c.persist("marks", id, c.f.marks, { provenance: p })
  ).json();
  const annotationId = first.annotationIds[0].annotationId as Id<"annotations">;
  await c.t.run((ctx) =>
    ctx.db.patch(annotationId, {
      labelText: data.annotation.why,
      status: "approved",
      approvedAt: Date.now(),
    }),
  );
  const approved = await c.t.run((ctx) => ctx.db.get(annotationId));
  await c.finish(id);
  expect(
    await (await c.persist("marks", id, c.f.marks, { provenance: p })).json(),
  ).toEqual(first);
  expect(await c.t.run((ctx) => ctx.db.get(annotationId))).toEqual(approved);
  expect(
    (
      await c.persist(
        "marks",
        id,
        { ...c.f.marks, why: c.f.moment.why },
        { provenance: p },
      )
    ).status,
  ).toBe(403);
  const next = await c.start("place", "synthetic-r1");
  const nextP = await c.provenance(next);
  expect(
    (await c.persist("marks", next, c.f.marks, { provenance: nextP })).status,
  ).toBe(403);
  expect(
    (await c.t.run((ctx) => ctx.db.get(next)))?.persistedOutputHash,
  ).toBeUndefined();
  expect(await c.t.run((ctx) => ctx.db.get(annotationId))).toEqual(approved);
});

test.each(["missing", "duplicate", "foreign", "pass-reason", "remark-status"])(
  "verdict %s rejection leaves all marks and receipt unchanged",
  async (mode) => {
    const c = await running();
    await c.base();
    const place = await c.start("place", "synthetic-r1");
    expect(
      (
        await c.persist("marks", place, c.f.marks, {
          provenance: await c.provenance(place),
        })
      ).status,
    ).toBe(200);
    await c.finish(place);
    const id = await c.start("check", "synthetic-r1"),
      o = structuredClone(c.f.verdicts);
    const before = await c.t.run((ctx) =>
      ctx.db.query("annotations").collect(),
    );
    if (mode === "missing") o.verdicts = [];
    if (mode === "duplicate") o.verdicts.push(o.verdicts[0]);
    if (mode === "foreign") o.verdicts[0].markId = "foreign";
    if (mode === "pass-reason") o.verdicts[0].pass = false;
    if (mode === "remark-status") o.remarkStatus = "player_missing";
    expect((await c.persist("verdicts", id, o)).status).toBe(403);
    expect(
      (await c.t.run((ctx) => ctx.db.get(id)))?.persistedOutputHash,
    ).toBeUndefined();
    expect(
      await c.t.run((ctx) => ctx.db.query("annotations").collect()),
    ).toEqual(before);
  },
);

test("tracking failure verdict stays unapproved and surfaces player_missing", async () => {
  const c = await running();
  await c.base();
  const place = await c.start("place", "synthetic-r1");
  expect(
    (
      await c.persist("marks", place, c.f.marks, {
        provenance: await c.provenance(place),
      })
    ).status,
  ).toBe(200);
  await c.finish(place);
  const id = await c.start("check", "synthetic-r1");
  const o = {
    remarkId: "synthetic-r1",
    verdicts: [{ markId: "synthetic-m1", pass: false, reason: "low_coverage" }],
    remarkStatus: "player_missing",
  };
  expect((await c.persist("verdicts", id, o)).status).toBe(200);
  expect(
    await c.t.run((ctx) => ctx.db.query("annotations").unique()),
  ).toMatchObject({ status: "player_missing", placedBy: "ai" });
  expect(
    (await c.t.run((ctx) => ctx.db.query("remarks").collect())).find(
      (r) => r.remarkId === "synthetic-r1",
    )?.status,
  ).toBe("player_missing");
});

test("plan retries preserve approved, edited and coach lesson entries and note-only defaults", async () => {
  const c = await running();
  await c.step("transcode", "transcode");
  await c.step("transcribe", "turns");
  await c.step("plan", "plan");
  const lesson = await c.t.run((ctx) => ctx.db.query("lessons").unique());
  await c.t.run((ctx) =>
    ctx.db.patch(lesson!._id, {
      focusPoints: lesson!.focusPoints.map((d) => ({
        ...d,
        title: c.f.moment.why,
        editedByCoach: true,
      })),
      notes: lesson!.notes.map((n) => ({
        ...n,
        text: c.f.moment.why,
        source: "coach",
        approved: true,
      })),
    }),
  );
  const before = await c.t.run((ctx) => ctx.db.get(lesson!._id));
  const next = await c.start("plan");
  expect((await c.persist("plan", next, c.f.plan)).status).toBe(200);
  expect(await c.t.run((ctx) => ctx.db.get(lesson!._id))).toEqual(before);
  const rows = await c.t.run((ctx) => ctx.db.query("remarks").collect());
  expect(rows.find((r) => r.remarkId === "synthetic-r2")).toMatchObject({
    mode: "note_only",
    includeInShare: false,
  });
  expect(
    (await c.t.run((ctx) => ctx.db.query("lessons").unique()))?.focusPoints[0]
      .approved,
  ).toBe(false);
});

test.each(["coach", "approved", "deleted", "edited"])(
  "new track attempt protects %s annotations and old exact mark mapping",
  async (mode) => {
    const c = await running();
    await c.base();
    const place = await c.start("place", "synthetic-r1");
    const p = await c.provenance(place);
    const mapping = await (
      await c.persist("marks", place, c.f.marks, { provenance: p })
    ).json();
    await c.finish(place);
    const id = mapping.annotationIds[0].annotationId as Id<"annotations">;
    await c.t.run((ctx) =>
      ctx.db.patch(
        id,
        mode === "coach"
          ? { placedBy: "coach" }
          : mode === "approved"
            ? { status: "approved", approvedAt: Date.now() }
            : mode === "deleted"
              ? { status: "deleted" }
              : { anchor: "box_bottom" },
      ),
    );
    const old = await c.t.run((ctx) => ctx.db.get(id));
    const track = await c.t.run((ctx) => ctx.db.query("tracks").unique());
    const next = await c.start("track", "synthetic-r1");
    expect(
      (
        await c.persist(
          "track",
          next,
          { ...c.f.track, fileRef: c.f.transcode.proxyKey },
          { cacheKey: data.run.inputHash },
        )
      ).status,
    ).toBe(403);
    expect(await c.t.run((ctx) => ctx.db.query("tracks").unique())).toEqual(
      track,
    );
    expect(await c.t.run((ctx) => ctx.db.get(id))).toEqual(old);
    expect(
      await (
        await c.persist("marks", place, c.f.marks, { provenance: p })
      ).json(),
    ).toEqual(mapping);
  },
);

test("verbatim failures return only the fixed mismatch code", async () => {
  const c = await running();
  await c.step("transcode", "transcode");
  await c.step("transcribe", "turns");
  const id = await c.start("plan");
  const o = structuredClone(c.f.plan);
  o.remarks[0].coachWords = c.f.moment.why;
  const response = await c.persist("plan", id, o);
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: "VERBATIM_MISMATCH" });
});

test("word boundaries use Unicode code points around UTF16 spans", async () => {
  const unicode = (
    await import("../../fixtures/synthetic/persistence/unicode.json")
  ).default;
  const c = await running();
  c.f.turns.turns[0].text = unicode.text;
  c.f.plan.remarks[0].coachWords = unicode.text;
  await c.base();
  const id = await c.start("place", "synthetic-r1"),
    p = await c.provenance(id),
    o = structuredClone(c.f.marks);
  Object.assign(o.marks[0].labelSpan, unicode.splitWord);
  expect((await c.persist("marks", id, o, { provenance: p })).status).toBe(403);
  expect(
    (await c.t.run((ctx) => ctx.db.get(id)))?.persistedOutputHash,
  ).toBeUndefined();
  Object.assign(o.marks[0].labelSpan, unicode.wholeWord);
  o.marks[0].labelText = unicode.text;
  expect((await c.persist("marks", id, o, { provenance: p })).status).toBe(200);
});
