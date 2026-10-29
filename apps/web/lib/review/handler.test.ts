// @vitest-environment node
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import { convexToJson, jsonToConvex } from "convex/values";
import { commitVerified } from "../../../../convex/review";
import { api } from "../../../../convex/_generated/api";
import { reviewReady } from "../../../../convex/tests/reviewHelpers";
import { POST } from "../../app/api/review/approve/route";
import { LocalVideoStorage } from "../storage";
import fixture from "../../../../fixtures/synthetic/review-verification.json";
const auth = vi.hoisted(() => ({ enabled: true }));
vi.mock("../coach-route-auth", () => ({
  getCoachRouteAuth: async () =>
    auth.enabled ? { convexToken: "test-only" } : null,
}));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  auth.enabled = true;
});
async function harness() {
  const c = await reviewReady();
  await mkdir(".orca-scratch", { recursive: true });
  const root = await mkdtemp(path.resolve(".orca-scratch/review-"));
  const secret = randomBytes(32).toString("hex");
  const storage = new LocalVideoStorage({
    rootDir: root,
    signingSecret: secret,
  });
  vi.stubEnv("STORAGE_DRIVER", "local");
  vi.stubEnv("LOCAL_STORAGE_DIR", root);
  vi.stubEnv("MEDIA_URL_SIGNING_SECRET", secret);
  vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", "https://convex.invalid");
  vi.stubEnv("CONVEX_SITE_URL", "https://convex.invalid");
  let foreign = false;
  let beforeCommit: ((init: RequestInit) => Promise<unknown>) | undefined;
  let commits = 0;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    if (String(url).endsWith("/svc/review/approve")) {
      commits++;
      await beforeCommit?.(init);
      init.signal?.throwIfAborted();
      return c.t.fetch("/svc/review/approve", init);
    }
    const body = JSON.parse(init.body as string);
    try {
      const value = await (foreign ? c.other : c.coach).query(
        makeFunctionReference<"query">(body.path),
        jsonToConvex(body.args[0]),
      );
      return Response.json({ status: "success", value: convexToJson(value) });
    } catch {
      return Response.json({ status: "error", errorMessage: "REJECTED" });
    }
  });
  const put = async (key: string, value: unknown) => {
    const url = await storage.signPutUrl(key, "application/json", 60);
    const req = new Request(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: typeof value === "string" ? value : JSON.stringify(value),
    });
    await storage.writeSignedPut(
      req,
      await storage.verifySignedRequest(req, key),
    );
  };
  await put(c.view.artifact!, c.f.transcode);
  await put(c.view.tracks[0].fileRef, fixture.track);
  const current = () =>
    c.coach.query(api.playback.get, { sessionId: c.sessionId });
  const request = async (
    extra = {},
    seen?: Awaited<ReturnType<typeof current>>,
  ) => {
    const view = seen ?? (await current());
    return POST(
      new Request("http://localhost/api/review/approve", {
        method: "POST",
        body: JSON.stringify({
          annotationId: c.id,
          expectedUpdatedAt: view.annotations[0].updatedAt,
          expectedRevision: view.revision,
          ...extra,
        }),
      }),
    );
  };
  return {
    ...c,
    root,
    put,
    current,
    request,
    getCommits: () => commits,
    foreign: () => {
      foreign = true;
    },
    race: (f: (init: RequestInit) => Promise<unknown>) => {
      beforeCommit = f;
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
test("real Next + ConvexHttpClient + private HTTP transaction approves actual original and retimed bytes, one item only", async () => {
  const c = await harness();
  try {
    const original = await c.t.run((ctx) => ctx.db.get(c.id));
    const sibling = await c.t.run(async (ctx) => {
      const { _id, _creationTime, ...copy } = original!;
      void _id;
      void _creationTime;
      return ctx.db.insert("annotations", {
        ...copy,
        markId: "synthetic-sibling",
      });
    });
    expect((await c.request()).status).toBe(200);
    expect((await c.t.run((ctx) => ctx.db.get(sibling)))!.status).toBe(
      original!.status,
    );
    await c.coach.mutation(api.review.move, {
      annotationId: c.id,
      anchor: "box_top",
      startMs: 200,
      endMs: 1000,
    });
    const draft = await c.current();
    await expect(
      c.coach.mutation(api.review.approve, { annotationId: c.id }),
    ).rejects.toThrow("PLACEMENT_CHECK_REQUIRED");
    expect((await c.request({}, draft)).status).toBe(200);
    expect(
      (await c.current()).annotations.find((a) => a.id === c.id)!.status,
    ).toBe("approved");
    const after = await c.t.run((ctx) => ctx.db.get(c.id));
    expect(after!.aiPlacement).toEqual(original!.aiPlacement);
    expect(after!.provenance).toEqual(original!.provenance);
    expect((await c.request({}, draft)).status).toBe(409); // consumed revision cannot upgrade anything
    expect((await c.request()).status).toBe(200); // exact current retry is read-only
    expect(await c.t.run((ctx) => ctx.db.get(c.id))).toEqual(after);
  } finally {
    await c.cleanup();
  }
});
for (const example of fixture.cases.filter((c) => c.start < c.end))
  test(`actual range: ${example.name}`, async () => {
    const c = await harness();
    try {
      await c.coach.mutation(api.review.move, {
        annotationId: c.id,
        anchor: "box_top",
        startMs: example.start,
        endMs: example.end,
      });
      await c.put(c.view.tracks[0].fileRef, {
        ...fixture.track,
        gaps: example.gaps ?? [],
        swaps: example.swaps ?? [],
      });
      const before = await c.t.run((ctx) => ctx.db.get(c.id));
      expect((await c.request()).status).toBe(example.pass ? 200 : 409);
      if (!example.pass)
        expect(await c.t.run((ctx) => ctx.db.get(c.id))).toEqual(before);
    } finally {
      await c.cleanup();
    }
  });
for (const source of [
  "missing",
  "malformed",
  "oversized",
  "symlink",
  "foreign",
  "foreign-ref",
  "subject",
  "artifact",
])
  test(`actual unsafe source rejects without mutation: ${source}`, async () => {
    const c = await harness();
    try {
      const key = c.view.tracks[0].fileRef;
      if (source === "foreign") c.foreign();
      else if (source === "foreign-ref")
        await c.t.run(async (ctx) => {
          const t = await ctx.db
            .query("tracks")
            .withIndex("by_sessionId", (q) => q.eq("sessionId", c.sessionId))
            .first();
          const run = (await ctx.db.get(c.runs.track))!;
          const fileRef = "sessions/foreign/track.json";
          await ctx.db.patch(t!._id, { fileRef });
          await ctx.db.patch(run._id, {
            persistedTrackBinding: { ...run.persistedTrackBinding!, fileRef },
          });
        });
      else if (source === "missing" || source === "symlink") {
        await rm(path.join(c.root, key));
        if (source === "symlink")
          await symlink(
            path.join(c.root, c.view.artifact!),
            path.join(c.root, key),
          );
      } else if (source === "subject")
        await c.put(key, { ...fixture.track, subjectOnly: false });
      else if (source === "artifact")
        await c.put(c.view.artifact!, { ...c.f.transcode, width: 640 });
      else await c.put(key, source === "malformed" ? "{" : " ".repeat(1048577));
      const before = await c.t.run((ctx) => ctx.db.get(c.id));
      expect((await c.request()).status).toBe(409);
      expect(await c.t.run((ctx) => ctx.db.get(c.id))).toEqual(before);
      expect(c.getCommits()).toBe(0);
    } finally {
      await c.cleanup();
    }
  });
test("retiming past an earlier subject swap cannot approve a renderer-suppressed track", async () => {
  const c = await harness();
  try {
    await c.coach.mutation(api.review.edit, {
      annotationId: c.id,
      startMs: 200,
      endMs: 1000,
      markType: "circle",
      anchor: "box_top",
      neutralLabel: "Batter",
    });
    await c.put(c.view.tracks[0].fileRef, {
      ...fixture.track,
      swaps: [{ ms: 100, reason: "jump" }],
    });
    const before = await c.t.run((ctx) => ctx.db.get(c.id));
    expect((await c.request()).status).toBe(409);
    expect(await c.t.run((ctx) => ctx.db.get(c.id))).toEqual(before);
    expect(c.getCommits()).toBe(0);
  } finally {
    await c.cleanup();
  }
});
for (const race of [
  "edit",
  "delete",
  "subject",
  "mode",
  "job",
  "config",
  "binding",
  "receipt",
  "source",
])
  test(`compare-and-commit rejects concurrent ${race}`, async () => {
    const c = await harness();
    try {
      let raced: unknown;
      c.race(async () => {
        await c.t.run(async (ctx) => {
          const a = (await ctx.db.get(c.id))!;
          const s = (await ctx.db.get(c.sessionId))!;
          if (race === "edit")
            await ctx.db.patch(c.id, {
              startMs: a.startMs + 1,
              updatedAt: a.updatedAt + 1,
            });
          if (race === "delete")
            await ctx.db.patch(c.id, {
              status: "deleted",
              updatedAt: a.updatedAt + 1,
            });
          if (race === "subject")
            await ctx.db.patch(c.sessionId, {
              subject: { ...s.subject!, selectedAt: s.subject!.selectedAt + 1 },
            });
          if (race === "job")
            await ctx.db.patch(s.latestJobId!, { status: "running" });
          if (race === "mode") {
            const r = await ctx.db
              .query("remarks")
              .withIndex("by_sessionId", (q) => q.eq("sessionId", c.sessionId))
              .first();
            await ctx.db.patch(r!._id, { mode: "note_only" });
          }
          if (race === "config") {
            const config = await ctx.db.query("pipeline_config").first();
            await ctx.db.patch(config!._id, {
              params: { ...config!.params, minMarkCoverage: 1 },
            });
          }
          if (race === "binding") {
            const t = await ctx.db
              .query("tracks")
              .withIndex("by_sessionId", (q) => q.eq("sessionId", c.sessionId))
              .first();
            await ctx.db.patch(t!._id, { fileRef: t!.fileRef + ".changed" });
          }
          if (race === "receipt")
            await ctx.db.patch(c.runs.track, {
              persistedOutputHash: "0".repeat(64),
            });
          if (race === "source")
            await ctx.db.patch(c.runs.transcode, {
              persistedOutputHash: "0".repeat(64),
            });
        });
        raced = await c.t.run((ctx) => ctx.db.get(c.id));
      });
      expect((await c.request()).status).toBe(409);
      expect(c.getCommits()).toBe(1);
      expect(await c.t.run((ctx) => ctx.db.get(c.id))).toEqual(raced);
    } finally {
      await c.cleanup();
    }
  });
test("closed browser body, stale confirmation, public claims and private auth cannot bypass", async () => {
  const c = await harness();
  try {
    const old = await c.current();
    await c.coach.mutation(api.review.move, {
      annotationId: c.id,
      anchor: "box_top",
      startMs: 200,
      endMs: 1000,
    });
    expect((await c.request({}, old)).status).toBe(409);
    expect((await c.request({ pass: true, coverage: 1 })).status).toBe(400);
    expect(
      (
        await c.t.fetch("/svc/review/approve", {
          method: "POST",
          body: JSON.stringify({ annotationId: c.id }),
        })
      ).status,
    ).toBe(401);
    expect(commitVerified).toHaveProperty("isInternal", true);
    await expect(
      c.coach.mutation(api.review.approve, {
        annotationId: c.id,
        pass: true,
        coverage: 1,
      } as never),
    ).rejects.toThrow();
    auth.enabled = false;
    expect((await c.request()).status).toBe(401);
    expect((await c.current()).annotations[0].status).not.toBe("approved");
  } finally {
    await c.cleanup();
  }
});
test("private service owner isolation, changed subject before query, cancellation and label rejection leave draft intact", async () => {
  const c = await harness();
  try {
    const view = await c.current();
    const input = await c.coach.query(api.review.approvalInput, {
      annotationId: c.id,
      expectedUpdatedAt: view.annotations[0].updatedAt,
      expectedRevision: view.revision,
    });
    const other = await c.other.mutation(api.coaches.ensure, {});
    const privateRequest = (coachId: typeof c.coachId, state = input.state) =>
      c.t.fetch("/svc/review/approve", {
        method: "POST",
        headers: {
          authorization: `Bearer ${process.env.CONVEX_SERVICE_SECRET}`,
        },
        body: JSON.stringify({
          annotationId: c.id,
          expectedUpdatedAt: input.updatedAt,
          coachId,
          expiresAt: Date.now() + 10000,
          state,
        }),
      });
    expect((await privateRequest(other)).status).toBe(400);
    expect((await privateRequest(c.coachId, "forged")).status).toBe(400);
    await c.coach.mutation(api.review.move, {
      annotationId: c.id,
      anchor: "box_top",
      startMs: 200,
      endMs: 1000,
    });
    expect((await privateRequest(c.coachId)).status).toBe(400);

    await c.t.run(async (ctx) => {
      const s = (await ctx.db.get(c.sessionId))!;
      await ctx.db.patch(s._id, {
        subject: { ...s.subject!, selectedAt: s.subject!.selectedAt - 1 },
      });
    });
    expect((await c.request({}, view)).status).toBe(409);
    const now = await c.current();
    const controller = new AbortController();
    controller.abort();
    const cancelled = await POST(
      new Request("http://localhost/api/review/approve", {
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify({
          annotationId: c.id,
          expectedUpdatedAt: now.annotations[0].updatedAt,
          expectedRevision: now.revision,
        }),
      }),
    );
    expect(cancelled.status).toBe(409);
    await c.t.run((ctx) => ctx.db.patch(c.id, { labelText: "invalid" }));
    const corrupt = await c.t.run((ctx) => ctx.db.get(c.id));
    expect((await c.request()).status).toBe(409);
    expect(await c.t.run((ctx) => ctx.db.get(c.id))).toEqual(corrupt);
  } finally {
    await c.cleanup();
  }
});
test("still frame requires its actual keyframe observation; note-only reads no tracking bytes", async () => {
  const c = await harness();
  try {
    const a = c.view.annotations[0];
    await c.coach.mutation(api.review.edit, {
      annotationId: c.id,
      markType: a.markType,
      anchor: a.anchor,
      startMs: 900,
      endMs: 1100,
      labelSpan: a.labelSpan,
      mode: "still_frame",
    });
    const still = {
      ...fixture.track,
      fps: 0,
      frames: fixture.track.frames.filter((f) => f.ms === 1000),
    };
    await c.put(c.view.tracks[0].fileRef, still);
    expect((await c.request()).status).toBe(200);
    await c.coach.mutation(api.review.edit, {
      annotationId: c.id,
      markType: a.markType,
      anchor: a.anchor,
      startMs: 900,
      endMs: 1100,
      labelSpan: a.labelSpan,
      mode: "still_frame",
    });
    await c.put(c.view.tracks[0].fileRef, {
      ...still,
      frames: fixture.track.frames.filter((f) => f.ms === 900),
    });
    expect((await c.request()).status).toBe(409);
    await c.coach.mutation(api.review.edit, {
      annotationId: c.id,
      markType: a.markType,
      anchor: a.anchor,
      startMs: 900,
      endMs: 1100,
      labelSpan: a.labelSpan,
      mode: "note_only",
    });
    await rm(path.join(c.root, c.view.tracks[0].fileRef));
    expect((await c.request()).status).toBe(200);
  } finally {
    await c.cleanup();
  }
});
test("expired verification cannot commit after a stalled bridge; draft can be retried", async () => {
  const c = await harness();
  try {
    const before = await c.t.run((ctx) => ctx.db.get(c.id));
    c.race(async (init) => {
      const body = JSON.parse(init.body as string);
      init.body = JSON.stringify({ ...body, expiresAt: Date.now() - 1 });
    });
    expect((await c.request()).status).toBe(409);
    expect(await c.t.run((ctx) => ctx.db.get(c.id))).toEqual(before);
    c.race(async () => undefined);
    expect((await c.request()).status).toBe(200);
  } finally {
    await c.cleanup();
  }
});
test("actual range coverage is authoritative rather than the whole-track summary", async () => {
  const c = await harness();
  try {
    await c.t.run(async (ctx) => {
      const t = await ctx.db
        .query("tracks")
        .withIndex("by_sessionId", (q) => q.eq("sessionId", c.sessionId))
        .first();
      await ctx.db.patch(t!._id, { coverage: 0 });
    });
    await c.coach.mutation(api.review.move, {
      annotationId: c.id,
      anchor: "box_top",
      startMs: 200,
      endMs: 1000,
    });
    expect((await c.request()).status).toBe(200);
  } finally {
    await c.cleanup();
  }
});
