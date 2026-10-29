// @vitest-environment node
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { ready } from "../convex/tests/helpers";

import { GET, PUT } from "../apps/web/app/api/media/local/[...key]/route";

// Real HTTP bridge to real convex-test transactions and actual Next signing/media exports.
// No live Convex deployment or browser E2E is claimed.
test("local orchestrator executes subprocess DAG over HTTP with probeable real outputs", async () => {
  const c = await ready();
  await mkdir(".orca-scratch", { recursive: true });
  const root = await mkdtemp(path.resolve(".orca-scratch/runtime-"));
  const service = randomBytes(32).toString("base64url");
  const workerSecret = randomBytes(32).toString("base64url");
  vi.stubEnv("CONVEX_SERVICE_SECRET", service);
  vi.stubEnv("WORKER_TOKEN_SECRET", workerSecret);
  vi.stubEnv("NETSENSE_ENV", "test");
  vi.stubEnv("STORAGE_DRIVER", "local");
  vi.stubEnv("LOCAL_STORAGE_DIR", root);
  vi.stubEnv("MEDIA_URL_SIGNING_SECRET", randomBytes(32).toString("base64url"));
  vi.stubEnv("SIGNED_URL_TTL_SECONDS", "600");
  const source = path.join(root, "source.mp4");
  const ffmpeg = spawnSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=black:s=320x180:r=10:d=3",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=24000:cl=mono",
    "-shortest",
    "-c:v",
    "libx264",
    "-c:a",
    "aac",
    source,
  ]);
  expect(ffmpeg.status).toBe(0);
  const bytes = await readFile(source);
  const sourceKey = `sessions/${c.sessionId}/original/source.mp4`;
  await mkdir(path.dirname(path.join(root, sourceKey)), { recursive: true });
  await writeFile(path.join(root, sourceKey), bytes);
  await c.t.run(async (ctx) => {
    await ctx.db.patch(c.uploadId, {
      storageKey: sourceKey,
      bytesTotal: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    await ctx.db.patch(c.sessionId, {
      subject: {
        frameMs: 0,
        point: { x: 0.47, y: 0.3 },
        role: "batter",
        selectedBy: "coach",
        selectedAt: Date.now(),
      },
      durationMs: 3000,
    });
    const config = await ctx.db.query("pipeline_config").first();
    if (!config) throw Error("missing config");
    await ctx.db.patch(config._id, {
      stages: config.stages.map((s) => ({
        ...s,
        retry: 0,
        ...(!["transcode", "check", "render"].includes(s.stage)
          ? {
              provider: "fake",
              model: null,
              workerId: s.stage + ".synthetic-test@1",
            }
          : {}),
        fallbackWorker: null,
        candidates: [],
        critic: null,
      })),
    });
  });
  const errors: string[] = [];
  let replayToken = "";
  const server = createServer(async (incoming, outgoing) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}${incoming.url}`;
      const init: RequestInit = {
        method: incoming.method,
        headers: incoming.headers as Record<string, string>,
      };
      if (incoming.method !== "GET") init.body = Buffer.concat(chunks);
      const request = new Request(url, init);
      let response: Response;
      if (incoming.url === "/api/worker/sign") response = await sign(request);
      else if (incoming.url?.startsWith("/api/media/local/")) {
        const context = {
          params: Promise.resolve({
            key: new URL(url).pathname
              .slice("/api/media/local/".length)
              .split("/")
              .map(decodeURIComponent),
          }),
        };
        response =
          incoming.method === "PUT"
            ? await PUT(request, context)
            : await GET(request, context);
      } else response = await c.t.fetch(incoming.url!, init);
      if (response.status >= 400)
        errors.push(
          `${incoming.url?.split("?")[0]}:${response.status}:${incoming.url?.endsWith("/target") ? (JSON.parse(Buffer.concat(chunks).toString()).output.anchorFrameMs === undefined ? "remark" : "anchor") : ""}`,
        );
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      const responseBytes = Buffer.from(await response.arrayBuffer());
      if (incoming.url === "/svc/jobs/claim" && response.status === 200)
        replayToken = JSON.parse(responseBytes.toString()).jobToken;
      outgoing.end(responseBytes);
    } catch {
      errors.push("BRIDGE_FAILED");
      outgoing.writeHead(500).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  vi.stubEnv("CONVEX_SITE_URL", origin);
  vi.stubEnv("APP_BASE_URL", origin);
  // Signing's fresh HTTP authorization uses actual Convex routing without a second server.
  vi.stubGlobal("fetch", (url: string | URL | Request, init?: RequestInit) =>
    c.t.fetch(new URL(String(url)).pathname, init),
  );
  const sign = (await import("../apps/web/app/api/worker/sign/route")).POST;
  try {
    const child = spawn(
      "uv",
      [
        "run",
        "--project",
        "services/orchestrator",
        "python",
        "-m",
        "netsense_orch",
        "--once",
      ],
      {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH,
          NETSENSE_ENV: "test",
          NETSENSE_LOCAL_FAKE: "1",
          SANDBOX_DRIVER: "local",
          CONVEX_SITE_URL: origin,
          VM_API_BASE_URL: origin,
          CONVEX_SERVICE_SECRET: service,
          NETSENSE_LOCAL_STATE_DIR: path.join(root, "state"),
          NETSENSE_ARTIFACT_ROOT: root,
          NETSENSE_RUNNER_SCRATCH: path.join(root, "scratch"),
          NETSENSE_FAKE_FIXTURES: path.resolve("fixtures/synthetic/dag"),
        },
      },
    );
    const status = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(Error("runtime deadline"));
      }, 45000);
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    expect(errors).toEqual([]);
    expect(status).toBe(0);
    const job = await c.t.run((ctx) => ctx.db.get(c.jobId));
    expect(job?.status).toBe("waiting_for_coach");
    const rows = await c.t.run((ctx) => ctx.db.query("sandboxes").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].terminatedAt).toBeTypeOf("number");
    const output = path.join(
      root,
      `sessions/${c.sessionId}/renders/preview/full.mp4`,
    );
    const probe = spawnSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "stream=codec_name",
        "-of",
        "json",
        output,
      ],
      { encoding: "utf8" },
    );
    expect(probe.status).toBe(0);
    expect(
      JSON.parse(probe.stdout).streams.map(
        (s: { codec_name: string }) => s.codec_name,
      ),
    ).toEqual(["h264", "aac"]);
    const annotations = await c.t.run((ctx) =>
      ctx.db.query("annotations").collect(),
    );
    expect(annotations).toHaveLength(2);
    const tracks = await c.t.run((ctx) => ctx.db.query("tracks").collect());
    expect(tracks).toHaveLength(2);
    for (const track of tracks) {
      const value = JSON.parse(
        await readFile(path.join(root, track.fileRef), "utf8"),
      );
      expect(value.subjectOnly).toBe(true);
      expect(value.frames.length).toBeGreaterThan(0);
      expect(
        value.frames.every(
          (f: { box: { x1: number; x2: number } }) =>
            f.box.x1 >= 500 && f.box.x2 <= 750,
        ),
      ).toBe(true);
    }
    const remarks = await c.t.run((ctx) => ctx.db.query("remarks").collect());
    const render = await c.t.run((ctx) => ctx.db.query("renders").first());
    if (!render) throw Error("render missing");
    await writeFile(
      path.join(root, "replay.json"),
      JSON.stringify({
        kind: "preview",
        mode: "video",
        durationMs: 3000,
        proxyKey: `sessions/${c.sessionId}/proxy.mp4`,
        annotations: annotations.map((a) => ({
          annotationId: a._id,
          keyframeMs: remarks.find((r) => r.remarkId === a.remarkId)
            ?.keyframeMs,
          markType: a.markType,
          anchor: a.anchor,
          arrowFrom: a.arrowFrom ?? null,
          startMs: a.startMs,
          endMs: a.endMs,
          labelText: a.labelText,
          placedBy: a.placedBy,
          trackFileRef: tracks.find((t) => t.trackId === a.trackId)?.fileRef,
        })),
        previousSegments: render.segmentRefs,
      }),
    );
    // Reauthorize only this test's completed attempt for storage replay; no auto-requeue.
    await c.t.run((ctx) =>
      ctx.db.patch(c.jobId, {
        status: "running",
        leaseUntil: Date.now() + 120000,
      }),
    );
    const replay = spawn(
      "uv",
      [
        "run",
        "--project",
        "services/orchestrator",
        "python",
        "fixtures/synthetic/local_driver/storage_replay.py",
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH,
          NETSENSE_ARTIFACT_ROOT: root,
          NETSENSE_SESSION: c.sessionId,
          NETSENSE_JOB_TOKEN: replayToken,
          CONVEX_SITE_URL: origin,
          VM_API_BASE_URL: origin,
        },
      },
    );
    const replayStatus = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        replay.kill();
        reject(Error("cache replay deadline"));
      }, 30000);
      replay.on("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    expect(replayStatus).toBe(0);
    expect(errors).toEqual([]);
    for (const annotation of annotations) {
      const still = await readFile(
        path.join(root, `sessions/${c.sessionId}/stills/${annotation._id}.jpg`),
      );
      expect(still.subarray(0, 2)).toEqual(Buffer.from([255, 216]));
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
}, 60000);

for (const mode of [
  "refresh",
  "stale",
  "cancelled",
  "external-fail",
  "superseded",
] as const) {
  test(`actual HTTP owned process control: ${mode}`, async () => {
    const c = await ready();
    await mkdir(".orca-scratch", { recursive: true });
    const root = await mkdtemp(path.resolve(".orca-scratch/control-"));
    const service = randomBytes(32).toString("base64url");
    vi.stubEnv("CONVEX_SERVICE_SECRET", service);
    vi.stubEnv("WORKER_TOKEN_SECRET", randomBytes(32).toString("base64url"));
    let controls = 0;
    const decisions: string[] = [];
    const errors: string[] = [];
    const server = createServer(async (incoming, outgoing) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
        if (incoming.url === "/svc/jobs/control") {
          controls++;
          if (controls === 1) {
            await c.t.run((ctx) => ctx.db.patch(c.jobId, { heartbeatAt: 0 }));
            const stale = await c.t.fetch("/svc/jobs/stale", {
              headers: { Authorization: `Bearer ${service}` },
            });
            expect(
              (await stale.json()).some(
                (r: { _id: string }) => r._id === c.jobId,
              ),
            ).toBe(true);
          }
          if (mode === "refresh") {
            // A stale observation precedes the heartbeat transaction, then control.
            await c.t.run((ctx) =>
              ctx.db.patch(
                c.jobId,
                controls < 3
                  ? { heartbeatAt: Date.now(), leaseUntil: Date.now() + 60000 }
                  : { status: "cancelled" },
              ),
            );
            if (controls === 3) {
              const { readdir } = await import("node:fs/promises");
              expect(
                (await readdir(path.join(root, "state"))).some((f) =>
                  f.endsWith(".released.json"),
                ),
              ).toBe(false);
              expect(await readFile(path.join(root, "pid"), "utf8")).toMatch(
                /^\d+/,
              );
            }
          } else if (mode === "external-fail") {
            const failed = await c.t.fetch("/svc/jobs/fail", {
              method: "POST",
              headers: { Authorization: `Bearer ${service}` },
              body: JSON.stringify({ jobId: c.jobId, errorCode: "INFRA_EXEC" }),
            });
            expect(failed.status).toBe(200);
          } else if (mode === "cancelled") {
            await c.t.run((ctx) =>
              ctx.db.patch(c.jobId, { status: "cancelled" }),
            );
          } else if (mode === "superseded") {
            await c.t.run((ctx) =>
              ctx.db.patch(c.jobId, { leaseOwner: "successor", attempt: 2 }),
            );
          }
        }
        const response = await c.t.fetch(incoming.url!, {
          method: incoming.method,
          headers: incoming.headers as Record<string, string>,
          ...(incoming.method === "GET" ? {} : { body: Buffer.concat(chunks) }),
        });
        const bytes = Buffer.from(await response.arrayBuffer());
        if (incoming.url === "/svc/jobs/control")
          decisions.push(JSON.parse(bytes.toString()).decision);
        if (response.status >= 400) errors.push("HTTP_REJECTED");
        outgoing.writeHead(
          response.status,
          Object.fromEntries(response.headers),
        );
        outgoing.end(bytes);
      } catch {
        errors.push("BRIDGE_FAILED");
        outgoing.writeHead(500).end();
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const started = Date.now();
      const child = spawn(
        "uv",
        [
          "run",
          "--project",
          "services/orchestrator",
          "python",
          "fixtures/synthetic/local_driver/control_http.py",
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            PATH: process.env.PATH,
            CONVEX_SITE_URL: origin,
            CONVEX_SERVICE_SECRET: service,
            NETSENSE_ENV: "test",
            NETSENSE_LOCAL_STATE_DIR: path.join(root, "state"),
          },
        },
      );
      const status = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill();
          reject(Error("control deadline"));
        }, 15000);
        child.on("exit", (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });
      expect(errors).toEqual([]);
      expect(status).toBe(0);
      expect(Date.now() - started).toBeLessThan(5000);
      expect(decisions).toEqual(
        mode === "refresh"
          ? ["continue", "continue", "terminal"]
          : [
              mode === "stale"
                ? "stopped"
                : mode === "cancelled" || mode === "external-fail"
                  ? "terminal"
                  : "superseded",
            ],
      );
      const job = await c.t.run((ctx) => ctx.db.get(c.jobId));
      expect(job?.status).toBe(
        mode === "stale" || mode === "external-fail"
          ? "failed"
          : mode === "superseded"
            ? "running"
            : "cancelled",
      );
      if (mode === "superseded") expect(job?.attempt).toBe(2);
      const rows = await c.t.run((ctx) => ctx.db.query("sandboxes").collect());
      expect(rows).toHaveLength(1);
      expect(rows[0].terminatedAt).toBeTypeOf("number");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  }, 20000);
}
