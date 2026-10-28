// @vitest-environment node
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { running, secret } from "./persistenceHelpers";
import { signJobToken } from "../lib/jobToken";

test("actual Next route reauthorizes every signing request through the Convex HTTP router", async () => {
  const c = await running();
  await mkdir(".orca-scratch", { recursive: true });
  const root = await mkdtemp(path.resolve(".orca-scratch/sign-wire-"));
  vi.stubEnv("STORAGE_DRIVER", "local");
  vi.stubEnv("LOCAL_STORAGE_DIR", root);
  vi.stubEnv("MEDIA_URL_SIGNING_SECRET", randomBytes(32).toString("base64url"));
  vi.stubEnv("APP_BASE_URL", "http://storage.invalid");
  vi.stubEnv("CONVEX_SITE_URL", "https://convex.invalid");
  vi.stubEnv("SIGNED_URL_TTL_SECONDS", "600");
  const upstream = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    expect(new URL(String(input)).pathname).toBe("/worker/job");
    return c.t.fetch("/worker/job", init);
  });
  vi.stubGlobal("fetch", upstream);
  try {
    const { POST } = await import("../../apps/web/app/api/worker/sign/route");
    const request = (token = c.token, sessionId: string = c.sessionId) => new Request("http://web.invalid/api/worker/sign", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ ops: [{ op: "put", key: `sessions/${sessionId}/proxy.mp4`, contentType: "video/mp4" }] }),
    });
    const success = await POST(request());
    expect(success.status).toBe(200);
    const body = await success.json() as { urls: { url: string; expiresAt: number }[] };
    const job = await c.t.run(ctx => ctx.db.get(c.jobId));
    expect(body.urls[0].expiresAt).toBeLessThanOrEqual(job!.leaseUntil!);
    expect(Number(new URL(body.urls[0].url).searchParams.get("exp")) * 1000).toBe(body.urls[0].expiresAt);

    await c.t.run(ctx => ctx.db.patch(c.sessionId, { latestJobId: undefined }));
    expect((await POST(request())).status).toBe(403);
    await c.t.run(ctx => ctx.db.patch(c.sessionId, { latestJobId: c.jobId }));
    await c.t.run(ctx => ctx.db.patch(c.jobId, { leaseUntil: Date.now() - 1 }));
    expect((await POST(request())).status).toBe(403);
    await c.t.run(ctx => ctx.db.patch(c.jobId, { leaseUntil: Date.now() + 60_000, status: "done" }));
    expect((await POST(request())).status).toBe(403);
    await c.t.run(ctx => ctx.db.patch(c.jobId, { status: "running" }));
    const foreign = crypto.randomUUID();
    const foreignToken = await signJobToken({ jobId: c.jobId, sessionId: foreign, exp: Date.now() + 60_000 }, secret);
    expect((await POST(request(foreignToken, foreign))).status).toBe(403);
    expect(upstream).toHaveBeenCalledTimes(5);
  } finally {
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
  }
});
