// @vitest-environment node
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { appendFile, truncate, mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { api } from "../../../../convex/_generated/api";
import { setup, tap, data } from "../../../../convex/tests/helpers";
import { LocalVideoStorage } from "../storage/local";

const state = vi.hoisted(() => ({
  auth: null as null | { clerkUserId: string; convexToken: string },
  query: vi.fn(),
}));
vi.mock("../coach-route-auth", () => ({
  getCoachRouteAuth: async () => state.auth,
}));
vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    setAuth() {}
    query = state.query;
  },
}));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function harness() {
  const c = await setup(false);
  await c.t.run((ctx) => ctx.db.delete(c.uploadId));
  await mkdir(".orca-scratch", { recursive: true });
  const root = await mkdtemp(path.resolve(".orca-scratch/upload-wire-"));
  const secret = randomBytes(32).toString("base64url");
  vi.stubEnv("STORAGE_DRIVER", "local");
  vi.stubEnv("LOCAL_STORAGE_DIR", root);
  vi.stubEnv("MEDIA_URL_SIGNING_SECRET", secret);
  vi.stubEnv("CONVEX_SERVICE_SECRET", randomBytes(32).toString("base64url"));
  vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", "https://convex.invalid");
  vi.stubEnv("CONVEX_SITE_URL", "https://convex.invalid");
  state.auth = {
    clerkUserId: data.identity.subject,
    convexToken: randomBytes(32).toString("base64url"),
  };
  state.query.mockImplementation((ref, args) => c.coach.query(ref, args));
  const fetcher = vi.fn((url: string, init: RequestInit) =>
    c.t.fetch(new URL(url).pathname, init),
  );
  vi.stubGlobal("fetch", fetcher);
  const storage = new LocalVideoStorage({
    rootDir: root,
    signingSecret: secret,
  });
  const handlers = {
    init: (await import("../../app/api/uploads/route")).POST,
    parts: (await import("../../app/api/uploads/[uploadId]/parts/route")).POST,
    confirm: (
      await import("../../app/api/uploads/[uploadId]/parts/confirm/route")
    ).POST,
    complete: (await import("../../app/api/uploads/[uploadId]/complete/route"))
      .POST,
    abort: (await import("../../app/api/uploads/[uploadId]/abort/route")).POST,
  };
  const bytes = randomBytes(data.upload.bytesTotal);
  const init = {
    sessionId: c.sessionId,
    fileName: randomUUID(),
    mimeType: data.upload.mimeType,
    bytesTotal: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const call = (op: keyof typeof handlers, body: unknown = {}, uploadId = "") =>
    handlers[op](
      new Request("https://web.invalid/api/uploads", {
        method: "POST",
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ uploadId }) },
    );
  const start = async () => {
    await c.coach.mutation(api.sessions.confirmConsent, {
      sessionId: c.sessionId,
    });
    const response = await call("init", init);
    expect(response.status).toBe(200);
    return (await response.json()).uploadId as string;
  };
  const put = async (id: string, content = bytes) => {
    const signed = await (await call("parts", { partNumbers: [1] }, id)).json();
    const request = new Request(signed.urls[0].url, {
      method: "PUT",
      body: content,
      headers: { "content-type": init.mimeType },
    });
    const key = `sessions/${c.sessionId}/source/original`;
    const auth = await storage.verifySignedRequest(request, key);
    return storage.writeSignedPut(request, auth);
  };
  return {
    ...c,
    call,
    start,
    put,
    init,
    bytes,
    storage,
    fetcher,
    root,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
test("actual routes: auth, ownership, consent never touches storage, closed input", async () => {
  const h = await harness();
  const spy = vi.spyOn(LocalVideoStorage.prototype, "initMultipart");
  try {
    state.auth = null;
    for (const op of ["init", "parts", "confirm", "complete", "abort"] as const)
      expect((await h.call(op, op === "init" ? h.init : {})).status).toBe(401);
    state.auth = {
      clerkUserId: data.identity.subject,
      convexToken: randomUUID(),
    };
    state.query.mockImplementation((ref, args) => h.other.query(ref, args));
    expect((await h.call("init", h.init)).status).toBe(409);
    state.query.mockImplementation((ref, args) => h.coach.query(ref, args));
    const response = await h.call("init", h.init);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "CONSENT_REQUIRED" });
    expect(spy).not.toHaveBeenCalled();
    expect(h.fetcher).not.toHaveBeenCalled();
    expect(
      (await h.call("init", { ...h.init, coachId: h.coachId })).status,
    ).toBe(409);
    for (const bytesTotal of [0, -1, 1.5, 5 * 1024 ** 3 + 1])
      expect(
        (await h.call("init", { ...h.init, bytesTotal })).status,
      ).toBeGreaterThanOrEqual(400);
  } finally {
    await h.cleanup();
  }
});
for (const order of ["tap-first", "upload-first"] as const)
  test(`actual routes + service router + disk: resume/progress/exactly once ${order}`, async () => {
    const h = await harness();
    try {
      const ids = await Promise.all([h.start(), h.start()]);
      expect(ids[0]).toBe(ids[1]);
      const id = ids[0];
      if (order === "tap-first")
        await h.coach.mutation(api.sessions.setSubject, {
          sessionId: h.sessionId,
          ...tap,
        });
      expect((await h.call("complete", {}, id)).status).toBe(409);
      for (const partNumbers of [[0], [2], [1, 1]])
        expect((await h.call("parts", { partNumbers }, id)).status).toBe(409);
      const part = await h.put(id);
      expect(
        (
          await h.call(
            "confirm",
            { partNumber: 1, ...part, bytes: part.bytes + 1 },
            id,
          )
        ).status,
      ).toBe(409);
      expect(
        (
          await h.call(
            "confirm",
            { partNumber: 1, ...part, etag: randomBytes(32).toString("hex") },
            id,
          )
        ).status,
      ).toBe(409);
      const confirms = await Promise.all([
        h.call("confirm", { partNumber: 1, ...part }, id),
        h.call("confirm", { partNumber: 1, ...part }, id),
      ]);
      for (const response of confirms)
        expect(await response.json()).toEqual({ bytesConfirmed: part.bytes });
      const resume = await (await h.call("init", h.init)).json();
      expect(resume.resumeFrom).toEqual([1]);
      state.query.mockImplementation((ref, args) => h.other.query(ref, args));
      for (const op of ["parts", "confirm", "complete", "abort"] as const)
        expect((await h.call(op, {}, id)).status).toBe(409);
      state.query.mockImplementation((ref, args) => h.coach.query(ref, args));
      const complete = await h.call("complete", {}, id);
      expect(complete.status).toBe(200);
      const result = await complete.json();
      if (order === "upload-first") {
        expect(result.jobId).toBeNull();
        await h.coach.mutation(api.sessions.setSubject, {
          sessionId: h.sessionId,
          ...tap,
        });
      }
      for (const response of await Promise.all([
        h.call("complete", {}, id),
        h.call("complete", {}, id),
      ]))
        expect(response.status).toBe(200);
      expect(
        await h.t.run((ctx) => ctx.db.query("jobs").collect()),
      ).toHaveLength(1);
      expect((await h.call("abort", {}, id)).status).toBe(409);
    } finally {
      await h.cleanup();
    }
  });
test("lost completion response recovers; competing abort cannot win completion reservation", async () => {
  const h = await harness();
  try {
    const id = await h.start();
    const part = await h.put(id);
    await h.call("confirm", { partNumber: 1, ...part }, id);
    const real = h.fetcher.getMockImplementation()!;
    let lose = true;
    h.fetcher.mockImplementation(async (url, init) => {
      const response = await real(url, init);
      if (url.endsWith("/complete") && lose) {
        lose = false;
        throw Error();
      }
      return response;
    });
    expect((await h.call("complete", {}, id)).status).toBe(409);
    expect((await h.call("abort", {}, id)).status).toBe(409);
    expect((await h.call("complete", {}, id)).status).toBe(200);
  } finally {
    await h.cleanup();
  }
});
test("abort is terminal and retries recover after storage response loss", async () => {
  const h = await harness();
  try {
    const id = await h.start();
    const real = h.fetcher.getMockImplementation()!;
    let lose = true;
    h.fetcher.mockImplementation(async (url, init) => {
      if (url.endsWith("/abort") && lose) {
        lose = false;
        throw Error();
      }
      return real(url, init);
    });
    expect((await h.call("abort", {}, id)).status).toBe(409);
    expect((await h.call("abort", {}, id)).status).toBe(200);
    expect((await h.call("abort", {}, id)).status).toBe(200);
    expect((await h.call("init", h.init)).status).toBe(409);
    expect((await h.call("complete", {}, id)).status).toBe(409);
  } finally {
    await h.cleanup();
  }
});
test("HEAD mismatch never persists completion; service bridge rejects browsers and claimed metadata", async () => {
  const h = await harness();
  try {
    const id = await h.start();
    const part = await h.put(id);
    await h.call("confirm", { partNumber: 1, ...part }, id);
    const original = LocalVideoStorage.prototype.completeMultipart;
    const source = path.join(h.root, `sessions/${h.sessionId}/source/original`);
    const spy = vi
      .spyOn(LocalVideoStorage.prototype, "completeMultipart")
      .mockImplementation(async function (this: LocalVideoStorage, ...args) {
        await original.apply(this, args);
        await appendFile(source, randomBytes(1));
      });
    expect((await h.call("complete", {}, id)).status).toBe(409);
    spy.mockRestore();
    await truncate(source, h.bytes.length);
    expect(
      (await h.call("complete", { verifiedBytes: h.bytes.length }, id)).status,
    ).toBe(409);
    expect(
      (
        await h.t.fetch("/svc/uploads/complete", {
          method: "POST",
          body: JSON.stringify({
            uploadId: id,
            coachId: h.coachId,
            verifiedBytes: h.bytes.length,
          }),
        })
      ).status,
    ).toBe(401);
    expect(await h.t.run((ctx) => ctx.db.query("jobs").collect())).toHaveLength(
      0,
    );
    expect((await h.call("complete", {}, id)).status).toBe(200);
  } finally {
    await h.cleanup();
  }
});

test("init reservation survives a lost DB response without orphan storage; stored consent checked again in bridge", async () => {
  const h = await harness();
  try {
    await h.coach.mutation(api.sessions.confirmConsent, {
      sessionId: h.sessionId,
    });
    const real = h.fetcher.getMockImplementation()!;
    let lose = true;
    h.fetcher.mockImplementation(async (url, init) => {
      const response = await real(url, init);
      if (url.endsWith("/reserve") && lose) {
        lose = false;
        throw Error();
      }
      return response;
    });
    expect((await h.call("init", h.init)).status).toBe(409);
    const rows = await h.t.run((ctx) => ctx.db.query("uploads").collect());
    expect(rows).toHaveLength(1);
    expect((await h.call("init", h.init)).status).toBe(200);
    expect(
      await h.t.run((ctx) => ctx.db.query("uploads").collect()),
    ).toHaveLength(1);
    await h.t.run((ctx) =>
      ctx.db.patch(h.sessionId, { consentConfirmedAt: undefined }),
    );
    const response = await h.t.fetch("/svc/uploads/begin", {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.CONVEX_SERVICE_SECRET}` },
      body: JSON.stringify({
        uploadId: rows[0]._id,
        coachId: h.coachId,
        operation: "aborting",
      }),
    });
    expect(response.status).toBe(400);
  } finally {
    await h.cleanup();
  }
});

test("actual multipart length, missing parts, immutable retries and final remainder", async () => {
  const h = await harness();
  try {
    await h.coach.mutation(api.sessions.confirmConsent, {
      sessionId: h.sessionId,
    });
    const content = randomBytes(8 * 1024 ** 2 + 7);
    const init = {
      ...h.init,
      bytesTotal: content.length,
      sha256: createHash("sha256").update(content).digest("hex"),
    };
    const id = (await (await h.call("init", init)).json()).uploadId;
    const urls = (
      await (await h.call("parts", { partNumbers: [1, 2] }, id)).json()
    ).urls;
    const key = `sessions/${h.sessionId}/source/original`;
    const write = async (index: number, bytes: Uint8Array) => {
      const request = new Request(urls[index].url, {
        method: "PUT",
        headers: { "content-type": init.mimeType },
        body: bytes as BodyInit,
      });
      return h.storage.writeSignedPut(
        request,
        await h.storage.verifySignedRequest(request, key),
      );
    };
    expect(
      (
        await h.call(
          "confirm",
          { partNumber: 1, etag: init.sha256, bytes: content.length },
          id,
        )
      ).status,
    ).toBe(409);
    const first = await write(0, content.subarray(0, 8 * 1024 ** 2));
    expect(await write(0, content.subarray(0, 8 * 1024 ** 2))).toEqual(first);
    await expect(write(0, randomBytes(first.bytes))).rejects.toThrow(
      "PART_CONFLICT",
    );
    await h.call("confirm", { partNumber: 1, ...first }, id);
    expect((await h.call("complete", {}, id)).status).toBe(409);
    const last = await write(1, content.subarray(8 * 1024 ** 2));
    expect(
      (await h.call("confirm", { partNumber: 2, ...last }, id)).status,
    ).toBe(200);
    expect((await h.call("complete", {}, id)).status).toBe(200);
    expect(await h.storage.head(key)).toMatchObject({ bytes: content.length });
  } finally {
    await h.cleanup();
  }
});

test("abort wins against a delayed init without leaking a multipart upload", async () => {
  const h = await harness();
  const original = LocalVideoStorage.prototype.initMultipart;
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  const spy = vi
    .spyOn(LocalVideoStorage.prototype, "initMultipart")
    .mockImplementation(async function (this: LocalVideoStorage, ...args) {
      if (first) {
        first = false;
        entered();
        await gate;
      }
      return original.apply(this, args);
    });
  try {
    await h.coach.mutation(api.sessions.confirmConsent, {
      sessionId: h.sessionId,
    });
    const init = h.call("init", h.init);
    await waiting;
    const row = (await h.t.run((ctx) => ctx.db.query("uploads").collect()))[0];
    expect((await h.call("abort", {}, row._id)).status).toBe(200);
    release();
    expect((await init).status).toBe(409);
    expect((await h.call("init", h.init)).status).toBe(409);
    await expect(
      h.storage.signPartUrls(row.storageKey, row.multipartUploadId!, [1], 60),
    ).rejects.toThrow("INVALID_UPLOAD_STATE");
  } finally {
    release();
    spy.mockRestore();
    await h.cleanup();
  }
});

test("request bounds cancel oversized/stalled streams; R2 fails closed", async () => {
  const h = await harness();
  try {
    const { POST } = await import("../../app/api/uploads/route");
    expect(
      (
        await POST(
          new Request("https://web.invalid/api/uploads", {
            method: "POST",
            body: JSON.stringify({ fileName: "x".repeat(33000) }),
          }),
        )
      ).status,
    ).toBe(409);
    let cancelled = false;
    vi.useFakeTimers();
    const pending = POST(
      new Request("https://web.invalid/api/uploads", {
        method: "POST",
        body: new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        duplex: "half",
      } as RequestInit),
    );
    await vi.advanceTimersByTimeAsync(10001);
    expect((await pending).status).toBe(409);
    expect(cancelled).toBe(true);
    vi.useRealTimers();
    await h.coach.mutation(api.sessions.confirmConsent, {
      sessionId: h.sessionId,
    });
    const spy = vi.spyOn(LocalVideoStorage.prototype, "initMultipart");
    vi.stubEnv("STORAGE_DRIVER", "r2");
    expect((await h.call("init", h.init)).status).toBe(409);
    expect(spy).not.toHaveBeenCalled();
    expect(h.fetcher).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
    await h.cleanup();
  }
});
