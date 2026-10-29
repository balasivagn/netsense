// @vitest-environment node
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import { convexToJson, jsonToConvex } from "convex/values";
import { reviewReady } from "../../../../convex/tests/reviewHelpers";
import { GET } from "../../app/api/media/local/[...key]/route";
import { POST } from "../../app/api/media/sign/route";
import { LocalVideoStorage } from "../storage";
import mediaRecipe from "../../../../fixtures/synthetic/playback-media.json";
import { tool } from "../selection-frames/extract";
import trackFixture from "../../../../fixtures/synthetic/overlay-geometry.json";
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
  const root = await mkdtemp(path.resolve(".orca-scratch/coach-media-"));
  const secret = randomBytes(32).toString("hex");
  const storage = new LocalVideoStorage({
    rootDir: root,
    signingSecret: secret,
  });
  vi.stubEnv("STORAGE_DRIVER", "local");
  vi.stubEnv("LOCAL_STORAGE_DIR", root);
  vi.stubEnv("MEDIA_URL_SIGNING_SECRET", secret);
  vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", "https://convex.invalid");
  let foreign = false;
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
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
  const put = async (
    key: string,
    value: unknown,
    type = "application/json",
  ) => {
    const url = await storage.signPutUrl(key, type, 60);
    const req = new Request(url, {
      method: "PUT",
      headers: { "Content-Type": type },
      body: Buffer.isBuffer(value)
        ? new Uint8Array(value)
        : typeof value === "string"
          ? value
          : JSON.stringify(value),
    });
    await storage.writeSignedPut(
      req,
      await storage.verifySignedRequest(req, key),
    );
  };
  const request = (asset: string, extra = {}) =>
    POST(
      new Request("http://localhost:3000/api/media/sign", {
        method: "POST",
        body: JSON.stringify({ sessionId: c.sessionId, asset, ...extra }),
      }),
    );
  await put(c.view.artifact!, c.f.transcode);
  const b = trackFixture.box;
  await put(c.view.tracks[0].fileRef, {
    fps: 10,
    subjectOnly: true,
    frames: [
      { ms: 1000, box: { x1: b[0], y1: b[1], x2: b[2], y2: b[3] }, conf: 1 },
    ],
    gaps: [],
    swaps: [],
  });
  return {
    ...c,
    root,
    storage,
    put,
    request,
    setForeign: () => {
      foreign = true;
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
test("actual handler resolves measured artifact refs, signs GET, validates track and expires", async () => {
  const c = await harness();
  try {
    const proxy = path.join(c.root, "synthetic.mp4"),
      audio = path.join(c.root, "synthetic.m4a");
    await tool(
      "ffmpeg",
      [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        mediaRecipe.videoFilter,
        "-f",
        "lavfi",
        "-i",
        mediaRecipe.audioFilter,
        "-t",
        String(mediaRecipe.durationSeconds),
        "-threads",
        "1",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        proxy,
      ],
      AbortSignal.timeout(10000),
    );
    await tool(
      "ffmpeg",
      ["-v", "error", "-i", proxy, "-vn", "-c:a", "copy", audio],
      AbortSignal.timeout(10000),
    );
    await c.put(c.f.transcode.proxyKey, await readFile(proxy), "video/mp4");
    await c.put(c.f.transcode.audioM4aKey, await readFile(audio), "audio/mp4");
    for (const asset of ["proxy", "audio", "track:synthetic-r1"]) {
      const r = await c.request(asset);
      expect(r.status, await r.clone().text()).toBe(200);
      const d = await r.json();
      expect(d.url).toContain("/api/media/local/sessions/");
      const key = new URL(d.url).pathname.split("/api/media/local/")[1];
      expect(
        (await c.storage.verifySignedRequest(new Request(d.url), key)).method,
      ).toBe("GET");
      const get = await GET(new Request(d.url), {
        params: Promise.resolve({ key: key.split("/") }),
      });
      expect(get.status).toBe(200);
      expect((await get.arrayBuffer()).byteLength).toBeGreaterThan(0);
      const expired = new LocalVideoStorage({
        rootDir: c.root,
        signingSecret: process.env.MEDIA_URL_SIGNING_SECRET!,
        now: () => d.expiresAt + 2000,
      });
      await expect(
        expired.verifySignedRequest(new Request(d.url), key),
      ).rejects.toThrow("INVALID_SIGNATURE");
    }
    expect((await c.request("preview")).status).toBe(409); // Missing actual render file never fabricates a ref.
  } finally {
    await c.cleanup();
  }
});
test("deny foreign/arbitrary before storage, closed and bounded request, unauthenticated", async () => {
  const c = await harness();
  try {
    const spy = vi.spyOn(LocalVideoStorage.prototype, "openRange");
    expect((await c.request("sessions/arbitrary/proxy.mp4")).status).toBe(404);
    expect(spy).not.toHaveBeenCalled();
    expect(
      (await c.request("proxy", { key: c.f.transcode.proxyKey })).status,
    ).toBe(400);
    c.setForeign();
    expect((await c.request("proxy")).status).toBe(409);
    expect(spy).not.toHaveBeenCalled();
    auth.enabled = false;
    expect((await c.request("proxy")).status).toBe(401);
  } finally {
    await c.cleanup();
  }
});
test("generated artifact/track contracts, semantic corruption, oversized reads and no-follow", async () => {
  const c = await harness();
  try {
    await c.put(c.view.tracks[0].fileRef, {
      fps: 10,
      subjectOnly: false,
      frames: [],
      gaps: [],
      swaps: [],
    });
    expect((await c.request("track:synthetic-r1")).status).toBe(409);
    await c.put(c.view.artifact!, {
      ...c.f.transcode,
      proxyKey: "https://invalid.example/proxy",
    });
    expect((await c.request("proxy")).status).toBe(409);
    await c.put(c.view.artifact!, " ".repeat(1048577));
    expect((await c.request("proxy")).status).toBe(409);
    await c.put(c.view.artifact!, c.f.transcode);
    const file = path.join(c.root, c.f.transcode.proxyKey);
    await mkdir(path.dirname(file), { recursive: true });
    await symlink(path.join(c.root, c.view.artifact!), file);
    expect((await c.request("proxy")).status).toBe(409);
  } finally {
    await c.cleanup();
  }
});

test("aborted request streams release the signing slot without waiting for body bytes", async () => {
  const c = await harness();
  try {
    const controller = new AbortController();
    let cancel = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancel = true;
      },
    });
    const pending = POST(
      new Request("http://localhost/api/media/sign", {
        method: "POST",
        body,
        duplex: "half",
        signal: controller.signal,
      } as RequestInit),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    expect((await pending).status).toBe(409);
    expect(cancel).toBe(true);
    expect((await c.request("arbitrary")).status).toBe(404);
  } finally {
    await c.cleanup();
  }
});
