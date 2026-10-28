// @vitest-environment node
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { MultipartUploadController } from "./multipart";
import { createUploadTransport } from "./transport";
import { browserRecoveryStore } from "./resume";
import { afterEach, expect, test, vi } from "vitest";
import { convexToJson, jsonToConvex } from "convex/values";
import { makeFunctionReference } from "convex/server";
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
  vi.stubEnv("APP_BASE_URL", "https://web.invalid");
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
  // Exercise the actual ConvexHttpClient and its bounded fetch wrapper. Only
  // the network boundary is in-process; query ownership still runs in Convex.
  const transport = vi.fn(async (url: string, init: RequestInit) => {
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    if (new URL(url).pathname === "/api/query") {
      expect(new Headers(init.headers).get("authorization")).toBe(
        `Bearer ${state.auth!.convexToken}`,
      );
      const body = JSON.parse(init.body as string);
      try {
        const value = await state.query(
          makeFunctionReference<"query">(body.path),
          jsonToConvex(body.args[0]),
        );
        return Response.json({ status: "success", value: convexToJson(value) });
      } catch {
        return Response.json({ status: "error", errorMessage: "NOT_FOUND" });
      }
    }
    return fetcher(url, init);
  });
  vi.stubGlobal("fetch", transport);
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
    transport,
    root,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

for (const tapFirst of [false, true])
  test(`browser client through real routes/Convex/disk: multi-part loss/retry, tapFirst=${tapFirst}`, async () => {
    const h = await harness();
    try {
      await h.coach.mutation(api.sessions.confirmConsent, {
        sessionId: h.sessionId,
      });
      if (tapFirst)
        await h.coach.mutation(api.sessions.setSubject, {
          sessionId: h.sessionId,
          ...tap,
        });
      const media = await import("../../app/api/media/local/[...key]/route");
      const routes = {
        parts: (await import("../../app/api/uploads/[uploadId]/parts/route"))
          .POST,
        confirm: (
          await import("../../app/api/uploads/[uploadId]/parts/confirm/route")
        ).POST,
        complete: (
          await import("../../app/api/uploads/[uploadId]/complete/route")
        ).POST,
        abort: (await import("../../app/api/uploads/[uploadId]/abort/route"))
          .POST,
      };
      let losePut = true,
        loseConfirm = true,
        loseComplete = true,
        puts = 0;
      const totals: number[] = [];
      const fetcher: typeof fetch = async (input, init) => {
        const url = new URL(String(input), "https://web.invalid");
        const request = new Request(url, init);
        if (init?.method === "PUT") {
          expect(init.credentials).toBe("omit");
          expect(init.redirect).toBe("error");
          puts++;
          const response = await media.PUT(request, {
            params: Promise.resolve({
              key: url.pathname.replace("/api/media/local/", "").split("/"),
            }),
          });
          if (losePut && response.ok) {
            losePut = false;
            throw Error("lost PUT response after disk persist");
          }
          return response;
        }
        if (url.pathname === "/api/uploads")
          return (await import("../../app/api/uploads/route")).POST(request);
        const id = url.pathname.split("/")[3];
        const op = url.pathname.endsWith("/parts/confirm")
          ? "confirm"
          : (url.pathname.split("/").at(-1) as keyof typeof routes);
        const response = await routes[op](request, {
          params: Promise.resolve({ uploadId: id }),
        });
        if (op === "confirm" && response.ok) {
          totals.push((await response.clone().json()).bytesConfirmed);
          if (loseConfirm) {
            loseConfirm = false;
            throw Error("lost confirmation after persist");
          }
        }
        if (op === "complete" && response.ok && loseComplete) {
          loseComplete = false;
          throw Error("lost completion after persist");
        }
        return response;
      };
      const bytes = randomBytes(2 * 8 * 1024 ** 2 + 7);
      const options = {
        coachId: h.coachId,
        sessionId: h.sessionId,
        file: new Blob([bytes], { type: "video/mp4" }),
        transport: createUploadTransport(fetcher),
        recovery: browserRecoveryStore(null),
        retryDelaysMs: [0, 0],
        partConcurrency: 1,
      };
      const client = new MultipartUploadController(options);
      expect(await client.start()).toMatchObject({
        phase: "ready_to_complete",
        confirmedBytes: bytes.length,
        confirmedParts: [1, 2, 3],
      });
      expect(totals).toEqual([
        8 * 1024 ** 2,
        8 * 1024 ** 2,
        16 * 1024 ** 2,
        bytes.length,
      ]);
      expect(puts).toBe(5);
      // A new controller rehashes and trusts only real persisted resume metadata.
      const resumed = new MultipartUploadController(options);
      expect(await resumed.start()).toMatchObject({
        phase: "ready_to_complete",
        confirmedBytes: bytes.length,
      });
      expect(puts).toBe(5);
      await expect(resumed.complete()).rejects.toThrow();
      expect(resumed.snapshot.phase).toBe("failed");
      await resumed.resume();
      const result = await resumed.complete();
      if (tapFirst) expect(typeof result.jobId).toBe("string");
      else expect(result).toEqual({ jobId: null });
      const head = await h.storage.head(
        `sessions/${h.sessionId}/source/original`,
      );
      expect(head?.bytes).toBe(bytes.length);
    } finally {
      await h.cleanup();
    }
  }, 30_000);

test("browser transport preserves actual consent rejection, closed response, and real cancellation", async () => {
  const h = await harness();
  try {
    const initRoute = (await import("../../app/api/uploads/route")).POST;
    const abortRoute = (
      await import("../../app/api/uploads/[uploadId]/abort/route")
    ).POST;
    let extra = false;
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input), "https://web.invalid");
      const request = new Request(url, init);
      const response = url.pathname.endsWith("/abort")
        ? await abortRoute(request, {
            params: Promise.resolve({ uploadId: url.pathname.split("/")[3] }),
          })
        : await initRoute(request);
      if (extra && response.ok)
        return Response.json({ ...(await response.json()), unexpected: true });
      return response;
    };
    const transport = createUploadTransport(fetcher);
    await expect(
      transport.initialize(h.init, new AbortController().signal),
    ).rejects.toThrow("CONSENT_REQUIRED");
    await h.coach.mutation(api.sessions.confirmConsent, {
      sessionId: h.sessionId,
    });
    extra = true;
    await expect(
      transport.initialize(h.init, new AbortController().signal),
    ).rejects.toThrow("INVALID_RESPONSE");
    extra = false;
    const initialized = await transport.initialize(
      h.init,
      new AbortController().signal,
    );
    await transport.abort(initialized.uploadId, new AbortController().signal);
    await expect(
      transport.initialize(h.init, new AbortController().signal),
    ).rejects.toThrow("UPLOAD_REJECTED");
    const row = await h.coach.query(api.uploads.owned, {
      uploadId: initialized.uploadId as typeof h.uploadId,
    });
    expect(row.status).toBe("aborted");
  } finally {
    await h.cleanup();
  }
});

test("controller cancellation aborts actual reserved upload while signing is pending", async () => {
  const h = await harness();
  try {
    await h.coach.mutation(api.sessions.confirmConsent, {
      sessionId: h.sessionId,
    });
    const initRoute = (await import("../../app/api/uploads/route")).POST;
    const abortRoute = (
      await import("../../app/api/uploads/[uploadId]/abort/route")
    ).POST;
    let uploadId = "",
      signing = false;
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input), "https://web.invalid");
      if (url.pathname.endsWith("/parts")) {
        signing = true;
        return new Promise<Response>((_, reject) =>
          init!.signal!.addEventListener(
            "abort",
            () => reject(new DOMException("", "AbortError")),
            { once: true },
          ),
        );
      }
      const request = new Request(url, init);
      if (url.pathname.endsWith("/abort"))
        return abortRoute(request, { params: Promise.resolve({ uploadId }) });
      const response = await initRoute(request);
      uploadId = (await response.clone().json()).uploadId;
      return response;
    };
    const client = new MultipartUploadController({
      coachId: h.coachId,
      sessionId: h.sessionId,
      file: new Blob([h.bytes], { type: h.init.mimeType }),
      transport: createUploadTransport(fetcher),
      recovery: browserRecoveryStore(null),
      retryDelaysMs: [],
    });
    const pending = client.start();
    await vi.waitFor(() => expect(signing).toBe(true));
    await client.cancel();
    await pending;
    expect(client.snapshot.phase).toBe("cancelled");
    const row = await h.coach.query(api.uploads.owned, {
      uploadId: uploadId as typeof h.uploadId,
    });
    expect(row.status).toBe("aborted");
    expect(
      await h.storage.head(`sessions/${h.sessionId}/source/original`),
    ).toBeNull();
  } finally {
    await h.cleanup();
  }
});
