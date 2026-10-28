// @vitest-environment node
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { signJobToken } from "../../../convex/lib/jobToken";
import { LocalVideoStorage } from "./storage";
import { createWorkerSignHandler } from "./worker-sign";
import type { VideoStorage } from "./storage";

const sessionId = "session-001";
const jobId = "job-001";
let now = 2_000_000_000_000;
let tokenSecret = "";
let root = "";

function secret(): string {
  return randomBytes(32).toString("base64url");
}

async function token(exp = now + 60_000): Promise<string> {
  return signJobToken({ jobId, sessionId, exp }, tokenSecret);
}

function job(overrides: Record<string, unknown> = {}) {
  return {
    job: {
      id: jobId,
      sessionId,
      status: "running",
      leaseUntil: now + 30_000,
      ...overrides,
    },
  };
}

function response(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
}

function storage(): VideoStorage & { calls: string[] } {
  const calls: string[] = [];
  return {
    driver: "local",
    calls,
    initMultipart: vi.fn(),
    signPartUrls: vi.fn(),
    completeMultipart: vi.fn(),
    abortMultipart: vi.fn(),
    head: vi.fn(),
    delete: vi.fn(),
    signGetUrl: vi.fn(async (key: string) => {
      calls.push(`get:${key}`);
      return `http://storage.invalid/get/${key}`;
    }),
    signPutUrl: vi.fn(async (key: string, contentType: string) => {
      calls.push(`put:${key}:${contentType}`);
      return `http://storage.invalid/put/${key}`;
    }),
  };
}

function handler(
  fetchImpl: typeof fetch,
  signedStorage = storage(),
  env: Record<string, string | undefined> = {},
) {
  return {
    storage: signedStorage,
    post: createWorkerSignHandler({
      env: {
        WORKER_TOKEN_SECRET: tokenSecret,
        CONVEX_SITE_URL: "https://convex.invalid",
        ...env,
      },
      storage: signedStorage,
      fetch: fetchImpl,
      now: () => now,
      upstreamTimeoutMs: 15,
    }),
  };
}

async function request(value: unknown, auth?: string): Promise<Request> {
  const authorization = auth ?? (await token());
  return new Request("http://web.invalid/api/worker/sign", {
    method: "POST",
    headers: {
      authorization: `Bearer ${authorization}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(value),
  });
}

beforeEach(async () => {
  tokenSecret = secret();
  await mkdir(path.join(process.cwd(), ".orca-scratch"), { recursive: true });
  root = await mkdtemp(path.join(process.cwd(), ".orca-scratch", "worker-sign-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("signs a validated ordered batch and sends the worker token to the current Convex job route", async () => {
  const fetchImpl = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    expect(String(input)).toBe("https://convex.invalid/worker/job");
    expect(init?.method).toBe("GET");
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${await token()}`);
    expect(init?.redirect).toBe("error");
    expect(init?.cache).toBe("no-store");
    return response(job());
  }) as unknown as typeof fetch;
  const signed = handler(fetchImpl);
  const result = await signed.post(
    await request({
      ops: [
        { op: "put", key: `sessions/${sessionId}/renders/final/full.mp4`, contentType: "video/mp4" },
        { op: "get", key: `sessions/${sessionId}/source/upload-001` },
      ],
    }),
  );
  expect(result.status).toBe(200);
  expect(result.headers.get("cache-control")).toBe("no-store");
  expect(await result.json()).toEqual({
    urls: [
      { op: "put", key: `sessions/${sessionId}/renders/final/full.mp4`, url: `http://storage.invalid/put/sessions/${sessionId}/renders/final/full.mp4`, expiresAt: now + 30_000 },
      { op: "get", key: `sessions/${sessionId}/source/upload-001`, url: `http://storage.invalid/get/sessions/${sessionId}/source/upload-001`, expiresAt: now + 30_000 },
    ],
  });
});

test("uses the local adapter's actual signed PUT implementation", async () => {
  const local = new LocalVideoStorage({ rootDir: root, signingSecret: secret(), baseUrl: "http://storage.invalid", now: () => now });
  const post = createWorkerSignHandler({
    env: { WORKER_TOKEN_SECRET: tokenSecret, CONVEX_SITE_URL: "https://convex.invalid" },
    storage: local,
    fetch: vi.fn(async () => response(job())) as unknown as typeof fetch,
    now: () => now,
  });
  const result = await post(await request({ ops: [{ op: "put", key: `sessions/${sessionId}/renders/final/full.mp4`, contentType: "video/mp4" }] }));
  const body = (await result.json()) as { urls: { url: string }[] };
  await expect(local.verifySignedRequest(new Request(body.urls[0].url, { method: "PUT", headers: { "content-type": "video/mp4" } }), `sessions/${sessionId}/renders/final/full.mp4`)).resolves.toMatchObject({ method: "PUT" });
});

test("rejects malformed, expired and bad-signature tokens before upstream or storage", async () => {
  const fetchImpl = vi.fn() as unknown as typeof fetch;
  const signed = handler(fetchImpl);
  for (const auth of ["not-a-token", await token(now), (await token()).replace(/.$/, "x")]) {
    const result = await signed.post(await request({ ops: [{ op: "get", key: `sessions/${sessionId}/source/upload-001` }] }, auth));
    expect(result.status).toBe(401);
  }
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(signed.storage.calls).toEqual([]);
});

test("rejects foreign, noncanonical, and mixed invalid batches atomically", async () => {
  const fetchImpl = vi.fn() as unknown as typeof fetch;
  const signed = handler(fetchImpl);
  for (const key of [
    "sessions/other/source/upload-001",
    `sessions/${sessionId}/source/../upload-001`,
    `sessions/${sessionId}/source/%252e%252e/upload-001`,
    `sessions/${sessionId}/source\\upload-001`,
    `sessions/${sessionId}//source/upload-001`,
  ]) {
    expect((await signed.post(await request({ ops: [{ op: "get", key }] }))).status).toBe(400);
  }
  expect((await signed.post(await request({ ops: [{ op: "get", key: `sessions/${sessionId}/source/upload-001` }, { op: "put", key: `sessions/${sessionId}/bad`, contentType: "text/plain\r\nX: y" }] }))).status).toBe(400);
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(signed.storage.calls).toEqual([]);
});

test("rejects bad bodies, too many operations, and invalid PUT metadata", async () => {
  const signed = handler(vi.fn() as unknown as typeof fetch);
  for (const value of [null, {}, { ops: [] }, { ops: Array.from({ length: 33 }, () => ({ op: "get", key: `sessions/${sessionId}/source/a` })) }, { ops: [{ op: "get", key: `sessions/${sessionId}/source/a`, contentType: "video/mp4" }] }, { ops: [{ op: "put", key: `sessions/${sessionId}/source/a` }] }])
    expect((await signed.post(await request(value))).status).toBe(400);
  const oversized = new Request("http://web.invalid", { method: "POST", headers: { authorization: `Bearer ${await token()}`, "content-type": "application/json" }, body: "x".repeat(32_769) });
  expect((await signed.post(oversized)).status).toBe(400);
});

test("fails closed for stopped jobs, stale leases, failed reads, redirects, oversized, and late upstream responses", async () => {
  const redirected = response(job());
  Object.defineProperty(redirected, "redirected", { value: true });
  const cases: typeof fetch[] = [
    vi.fn(async () => response(job({ status: "done" }))) as unknown as typeof fetch,
    vi.fn(async () => response(job({ leaseUntil: now }))) as unknown as typeof fetch,
    vi.fn(async () => response({}, { status: 500 })) as unknown as typeof fetch,
    vi.fn(async () => redirected) as unknown as typeof fetch,
    vi.fn(async () => response({ job: { ...job().job, padding: "x".repeat(1_048_576) } })) as unknown as typeof fetch,
  ];
  for (const fetchImpl of cases) {
    const signed = handler(fetchImpl);
    expect((await signed.post(await request({ ops: [{ op: "get", key: `sessions/${sessionId}/source/a` }] }))).status).not.toBe(200);
    expect(signed.storage.calls).toEqual([]);
  }
  const slow = handler((() => new Promise<Response>(() => undefined)) as typeof fetch);
  expect((await slow.post(await request({ ops: [{ op: "get", key: `sessions/${sessionId}/source/a` }] }))).status).toBe(503);
});

test("caps expiry by token and rejects an elapsed token or lease after the current-job read", async () => {
  const signed = handler(vi.fn(async () => response(job({ leaseUntil: now + 90_000 }))) as unknown as typeof fetch);
  const result = await signed.post(await request({ ops: [{ op: "get", key: `sessions/${sessionId}/source/a` }] }, await token(now + 1_500)));
  expect(((await result.json()) as { urls: { expiresAt: number }[] }).urls[0].expiresAt).toBe(now + 1_000);
  const elapsed = handler(vi.fn(async () => { now += 31_000; return response(job({ leaseUntil: now + 1_000 })); }) as unknown as typeof fetch);
  expect((await elapsed.post(await request({ ops: [{ op: "get", key: `sessions/${sessionId}/source/a` }] }, await token(now + 30_000)))).status).toBe(403);
});
