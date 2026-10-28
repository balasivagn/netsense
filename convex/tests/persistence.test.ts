import { expect, test } from "vitest";
import { running, post, secret } from "./persistenceHelpers";
import { data } from "./helpers";
import { signJobToken } from "../lib/jobToken";
import type { Id } from "../_generated/dataModel";

test("coherent real HTTP core path reaches ready preview; exact replay preserves rows and timestamps", async () => {
  const c = await running();
  await c.base();
  const place = await c.start("place", "synthetic-r1"),
    p = await c.provenance(place);
  const response = await c.persist("marks", place, c.f.marks, {
    provenance: p,
  });
  expect(response.status, await response.clone().text()).toBe(200);
  const mapping = await response.json();
  expect(mapping.annotationIds).toHaveLength(1);
  const before = await c.t.run((ctx) => ctx.db.query("annotations").collect());
  expect(before[0]).toMatchObject({
    placedBy: "ai",
    status: "needs_you",
    labelText: c.f.marks.marks[0].labelText,
  });
  expect(before[0].approvedAt).toBeUndefined();
  await c.finish(place);
  expect(
    await (
      await c.persist("marks", place, c.f.marks, { provenance: p })
    ).json(),
  ).toEqual(mapping);
  expect(await c.t.run((ctx) => ctx.db.query("annotations").collect())).toEqual(
    before,
  );
  await c.step("check", "verdicts", "synthetic-r1");
  await c.step("render", "render");
  const render = await c.t.run((ctx) => ctx.db.query("renders").unique());
  expect(render).toMatchObject({
    kind: "preview",
    status: "ready",
    fileRef: c.f.render.fileRef,
  });
  expect((await c.persist("render", c.runs.render, c.f.render)).status).toBe(
    200,
  );
  expect(await c.t.run((ctx) => ctx.db.query("renders").unique())).toEqual(
    render,
  );
  const annotation = await c.t.run((ctx) =>
    ctx.db.get(mapping.annotationIds[0].annotationId as Id<"annotations">),
  );
  expect(annotation?.provenance.stageRunIds.check).toBe(c.runs.check);
  expect(annotation?.status).toBe("needs_you");
  expect(
    (
      await c.t.fetch(
        "/worker/done",
        post({ status: "waiting_for_coach" }, c.token),
      )
    ).status,
  ).toBe(200);
  expect(await c.t.run((ctx) => ctx.db.get(c.sessionId))).toMatchObject({
    status: "review_ready",
    subjectStatus: "anchored",
    durationMs: 2000,
  });
  expect((await c.persist("render", c.runs.render, c.f.render)).status).toBe(
    403,
  );
});

test.each([
  "transcode",
  "turns",
  "plan",
  "moment",
  "target",
  "track",
  "marks",
  "verdicts",
  "render",
] as const)(
  "%s denies forged, foreign, wrong run, stopped and expired authorities without writes",
  async (name) => {
    const c = await running();
    await c.base();
    const place = await c.start("place", "synthetic-r1");
    const check = await c.start("check", "synthetic-r1");
    const render = await c.start("render");
    const map = {
      transcode: c.runs.transcode,
      turns: c.runs.transcribe,
      plan: c.runs.plan,
      moment: c.runs.moment,
      target: c.runs.subject,
      track: c.runs.track,
      marks: place,
      verdicts: check,
      render,
    };
    const id = map[name],
      metadata =
        name === "track"
          ? { cacheKey: data.run.inputHash }
          : name === "marks"
            ? { provenance: await c.provenance(place) }
            : {};
    const snapshot = () =>
      c.t.run(async (ctx) => ({
        runs: await ctx.db.query("stageRuns").collect(),
        marks: await ctx.db.query("annotations").collect(),
        renders: await ctx.db.query("renders").collect(),
        turns: await ctx.db.query("transcriptTurns").collect(),
        remarks: await ctx.db.query("remarks").collect(),
      }));
    const before = await snapshot();
    expect(
      (
        await c.t.fetch(
          `/worker/persist/${name}`,
          post({ stageRunId: id, output: c.f[name], ...metadata }, "forged"),
        )
      ).status,
    ).toBe(401);
    const foreign = await signJobToken(
      {
        jobId: c.jobId,
        sessionId: crypto.randomUUID(),
        exp: Date.now() + 60000,
      },
      secret,
    );
    expect(
      (
        await c.t.fetch(
          `/worker/persist/${name}`,
          post({ stageRunId: id, output: c.f[name], ...metadata }, foreign),
        )
      ).status,
    ).toBe(403);
    const expired = await signJobToken(
      { jobId: c.jobId, sessionId: c.sessionId, exp: Date.now() },
      secret,
    );
    expect(
      (
        await c.t.fetch(
          `/worker/persist/${name}`,
          post({ stageRunId: id, output: c.f[name], ...metadata }, expired),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await c.persist(
          name,
          name === "render" ? place : render,
          c.f[name],
          metadata,
        )
      ).status,
    ).toBe(403);
    await c.t.run((ctx) => ctx.db.patch(c.jobId, { leaseUntil: Date.now() }));
    expect((await c.persist(name, id, c.f[name], metadata)).status).toBe(403);
    await c.t.run((ctx) =>
      ctx.db.patch(c.jobId, {
        leaseUntil: Date.now() + 60000,
        status: "failed",
      }),
    );
    expect((await c.persist(name, id, c.f[name], metadata)).status).toBe(403);
    // Ignore intentionally added authority-test run; existing projection rows unchanged.
    const after = await snapshot();
    expect(after.marks).toEqual(before.marks);
    expect(after.renders).toEqual(before.renders);
    expect(after.turns).toEqual(before.turns);
    expect(after.remarks).toEqual(before.remarks);
  },
);

test("worker projection returns actual label/role only and absent/foreign/empty student fails closed", async () => {
  const c = await running();
  await c.t.run((ctx) =>
    ctx.db.patch(c.studentId, { contactMasked: data.annotation.why }),
  );
  const get = () =>
    c.t.fetch("/worker/job", {
      headers: { authorization: `Bearer ${c.token}` },
    });
  const wire = await (await get()).json();
  expect(wire.session).toMatchObject({
    studentLabel: data.studentLabel,
    subjectRole: "batter",
  });
  expect(JSON.stringify(wire)).not.toContain("contactMasked");
  expect(JSON.stringify(wire)).not.toContain(data.annotation.why);
  await c.t.run((ctx) => ctx.db.patch(c.studentId, { label: "" }));
  expect((await get()).status).toBe(403);
  const otherCoach = await c.t.run(async (ctx) =>
    (await ctx.db.query("coaches").collect()).find(
      (coach) => coach._id !== c.coachId,
    )!,
  );
  await c.t.run((ctx) =>
    ctx.db.patch(c.studentId, {
      label: data.studentLabel,
      coachId: otherCoach._id,
    }),
  );
  expect((await get()).status).toBe(403);
  await c.t.run((ctx) => ctx.db.delete(c.studentId));
  expect((await get()).status).toBe(403);
});

test("structural and semantic failures roll back receipt and every projection", async () => {
  const c = await running(),
    id = await c.start("transcode");
  for (const output of [
    { ...c.f.transcode, extra: true },
    { ...c.f.transcode, width: 0 },
    { ...c.f.transcode, fps: null },
    { ...c.f.transcode, proxyKey: "sessions/foreign/proxy.mp4" },
    {
      ...c.f.transcode,
      audioWavKeys: [{ ...c.f.transcode.audioWavKeys[0], offsetMs: 1000 }],
    },
  ]) {
    expect((await c.persist("transcode", id, output)).status).toBe(403);
    expect(
      (await c.t.run((ctx) => ctx.db.get(id)))?.persistedOutputHash,
    ).toBeUndefined();
  }
  expect((await c.persist("transcode", id, c.f.transcode)).status).toBe(200);
  const before = await c.t.run((ctx) => ctx.db.get(id));
  expect(
    (await c.persist("transcode", id, { ...c.f.transcode, width: 640 })).status,
  ).toBe(403);
  expect(await c.t.run((ctx) => ctx.db.get(id))).toEqual(before);
  await c.finish(id);
  expect((await c.persist("transcode", id, c.f.transcode)).status).toBe(200);
});

test("immutable original turns preserve correctedText and changed or duplicate turns reject atomically", async () => {
  const c = await running();
  await c.step("transcode", "transcode");
  const first = await c.step("transcribe", "turns");
  const row = await c.t.run((ctx) => ctx.db.query("transcriptTurns").first());
  await c.t.run((ctx) =>
    ctx.db.patch(row!._id, { correctedText: data.annotation.why }),
  );
  const next = await c.start("transcribe");
  expect(
    (
      await c.persist("turns", next, {
        ...c.f.turns,
        turns: [{ ...c.f.turns.turns[0], text: data.annotation.why }],
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await c.persist("turns", next, {
        ...c.f.turns,
        turns: [c.f.turns.turns[0], c.f.turns.turns[0]],
      })
    ).status,
  ).toBe(403);
  expect((await c.persist("turns", next, c.f.turns)).status).toBe(200);
  expect((await c.t.run((ctx) => ctx.db.get(row!._id)))?.correctedText).toBe(
    data.annotation.why,
  );
  expect((await c.persist("turns", first, c.f.turns)).status).toBe(200);
});

test.each([
  "transcode",
  "turns",
  "plan",
  "moment",
  "target",
  "track",
  "marks",
  "verdicts",
  "render",
] as const)(
  "%s requires a closed complete nonnull contract and actual owned row",
  async (name) => {
    const c = await running();
    await c.base();
    const place = await c.start("place", "synthetic-r1"),
      check = await c.start("check", "synthetic-r1"),
      render = await c.start("render");
    const ids = {
        transcode: c.runs.transcode,
        turns: c.runs.transcribe,
        plan: c.runs.plan,
        moment: c.runs.moment,
        target: c.runs.subject,
        track: c.runs.track,
        marks: place,
        verdicts: check,
        render,
      },
      id = ids[name];
    const metadata =
      name === "track"
        ? { cacheKey: data.run.inputHash }
        : name === "marks"
          ? { provenance: await c.provenance(place) }
          : {};
    const original = await c.t.run((ctx) => ctx.db.get(id));
    for (const output of [null, {}, [], { ...c.f[name], unknown: true }])
      expect((await c.persist(name, id, output, metadata)).status).toBe(403);
    const foreign = await c.t.run(async (ctx) => {
      const session = (await ctx.db.get(c.sessionId))!;
      const { _id, _creationTime, ...copy } = session;
      void _id;
      void _creationTime;
      const sessionId = await ctx.db.insert("sessions", copy);
      const run = (await ctx.db.get(id))!;
      const { _id: runId, _creationTime: created, ...runCopy } = run;
      void runId;
      void created;
      return ctx.db.insert("stageRuns", { ...runCopy, sessionId });
    });
    expect((await c.persist(name, foreign, c.f[name], metadata)).status).toBe(
      403,
    );
    expect(await c.t.run((ctx) => ctx.db.get(id))).toEqual(original);
    expect(
      (
        await c.t.fetch(
          `/worker/persist/${name}`,
          post(
            {
              stageRunId: id,
              output: c.f[name],
              ...metadata,
              coachId: c.coachId,
            },
            c.token,
          ),
        )
      ).status,
    ).toBe(403);
  },
);

test("persistence streams enforce 1 MiB independently of content length; larger valid turns exceed lifecycle cap", async () => {
  const c = await running();
  await c.step("transcode", "transcode");
  const id = await c.start("transcribe");
  const text = c.f.turns.turns[0].text.repeat(2000);
  const output = { ...c.f.turns, turns: [{ ...c.f.turns.turns[0], text }] };
  expect((await c.persist("turns", id, output)).status).toBe(200);
  for (const length of [undefined, "1"]) {
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        stageRunId: id,
        output: {
          ...output,
          turns: [{ ...output.turns[0], text: text.repeat(30) }],
        },
      }),
    );
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 4096)
          controller.enqueue(bytes.slice(i, i + 4096));
        controller.close();
      },
    });
    expect(
      (
        await c.t.fetch("/worker/persist/turns", {
          method: "POST",
          headers: {
            authorization: `Bearer ${c.token}`,
            ...(length ? { "content-length": length } : {}),
          },
          body: stream,
          duplex: "half",
        } as RequestInit & { duplex: string })
      ).status,
    ).toBe(400);
  }
});

test("render rejects final, wrong mode/duration and foreign still ids without ready rows", async () => {
  const c = await running();
  await c.base();
  const id = await c.start("render");
  for (const o of [
    { ...c.f.render, kind: "final" },
    { ...c.f.render, mode: "stills" },
    { ...c.f.render, durationMs: 1999 },
    {
      ...c.f.render,
      stillRefs: [
        { annotationId: c.sessionId, key: c.f.anchor.referenceCropKey },
      ],
    },
    { ...c.f.render, fileRef: "sessions/foreign/render.mp4" },
  ]) {
    expect((await c.persist("render", id, o)).status).toBe(403);
    expect(await c.t.run((ctx) => ctx.db.query("renders").collect())).toEqual(
      [],
    );
    expect(
      (await c.t.run((ctx) => ctx.db.get(id)))?.persistedOutputHash,
    ).toBeUndefined();
  }
});

test.each(["range", "keyframe", "remark", "candidate"])(
  "moment %s rejection rolls back receipt",
  async (mode) => {
    const c = await running();
    await c.step("transcode", "transcode");
    await c.step("transcribe", "turns");
    await c.step("plan", "plan");
    const id = await c.start("moment", "synthetic-r1");
    const o = structuredClone(c.f.moment);
    if (mode === "range") o.endMs = 2001;
    if (mode === "keyframe") o.keyframeMs = 2000;
    if (mode === "remark") o.remarkId = "synthetic-r2";
    if (mode === "candidate")
      Object.assign(o, { candidates: [{ startMs: 0, endMs: 2001 }] });
    expect((await c.persist("moment", id, o)).status).toBe(403);
    expect(
      (await c.t.run((ctx) => ctx.db.get(id)))?.persistedOutputHash,
    ).toBeUndefined();
    expect(
      (await c.t.run((ctx) => ctx.db.query("remarks").collect())).every(
        (r) => r.momentStartMs === undefined,
      ),
    ).toBe(true);
  },
);

test("anchor requires current tap, matching frame, canonical crop and ordered box", async () => {
  const c = await running();
  await c.step("transcode", "transcode");
  const id = await c.start("subject");
  for (const o of [
    { ...c.f.anchor, anchorFrameMs: 0 },
    { ...c.f.anchor, referenceCropKey: "sessions/foreign/crop.jpg" },
    { ...c.f.anchor, anchorBox: { x1: 100, y1: 10, x2: 10, y2: 100 } },
  ])
    expect((await c.persist("target", id, o)).status).toBe(403);
  await c.t.run((ctx) => ctx.db.patch(c.sessionId, { subject: undefined }));
  expect((await c.persist("target", id, c.f.anchor)).status).toBe(403);
  expect(
    (await c.t.run((ctx) => ctx.db.get(id)))?.persistedOutputHash,
  ).toBeUndefined();
  expect(
    (await c.t.run((ctx) => ctx.db.get(c.sessionId)))?.subjectAnchor,
  ).toBeUndefined();
});

test("persistence rejects nonfinite JSON numbers, invalid UTF8 and malformed JSON", async () => {
  const c = await running(),
    id = await c.start("transcode");
  const body = JSON.stringify({
    stageRunId: id,
    output: c.f.transcode,
  }).replace('"fps":25', '"fps":1e400');
  for (const bytes of [body, "{", new Uint8Array([255])])
    expect(
      (
        await c.t.fetch("/worker/persist/transcode", {
          ...post({}, c.token),
          body: bytes,
        })
      ).status,
    ).toBeGreaterThanOrEqual(400);
  expect(
    (await c.t.run((ctx) => ctx.db.get(id)))?.persistedOutputHash,
  ).toBeUndefined();
});

test("cost, nextFocus and agent trace persistence are explicitly unregistered", async () => {
  const c = await running();
  for (const path of [
    "/worker/cost",
    "/worker/persist/nextFocus",
    "/worker/persist/agentTraces",
  ])
    expect((await c.t.fetch(path, post({}, c.token))).status).toBe(404);
});

test("new AI attempts replace derived rows while original marks response replay remains stable", async () => {
  const c = await running();
  await c.base();
  const place = await c.start("place", "synthetic-r1"),
    p = await c.provenance(place);
  const first = await (
    await c.persist("marks", place, c.f.marks, { provenance: p })
  ).json();
  await c.finish(place);
  const track = await c.start("track", "synthetic-r1");
  expect(
    (
      await c.persist(
        "track",
        track,
        { ...c.f.track, fileRef: c.f.transcode.proxyKey },
        { cacheKey: data.run.inputHash },
      )
    ).status,
  ).toBe(200);
  await c.finish(track);
  const next = await c.start("place", "synthetic-r1"),
    nextP = await c.provenance(next),
    o = structuredClone(c.f.marks);
  o.marks[0].anchor = "box_bottom";
  const newer = await c.persist("marks", next, o, { provenance: nextP });
  expect(newer.status).toBe(200);
  expect((await newer.json()).annotationIds).toEqual(first.annotationIds);
  const row = await c.t.run((ctx) => ctx.db.query("annotations").unique());
  expect(row).toMatchObject({
    anchor: "box_bottom",
    status: "needs_you",
    provenance: { stageRunIds: { place: next, track } },
  });
  expect(
    await (
      await c.persist("marks", place, c.f.marks, { provenance: p })
    ).json(),
  ).toEqual(first);
  expect(await c.t.run((ctx) => ctx.db.query("annotations").unique())).toEqual(
    row,
  );
});
