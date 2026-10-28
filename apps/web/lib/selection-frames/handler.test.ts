// @vitest-environment node
// Actual Next handler, ConvexHttpClient/convex-test transactions and disk/tools.
// Clerk and HTTP delivery are seams; this is NOT browser/live vendor E2E.
import * as processes from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
} from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { convexToJson, jsonToConvex } from "convex/values";
import { makeFunctionReference } from "convex/server";
import { api, internal } from "../../../../convex/_generated/api";
import { setup, tap } from "../../../../convex/tests/helpers";
import { LocalVideoStorage } from "../storage/local";
import { extract, tool } from "./extract";
import { GET } from "../../app/api/sessions/[id]/selection-frames/route";
vi.mock("node:child_process", { spy: true });
const state = vi.hoisted(() => ({ auth: true }));
vi.mock("../coach-route-auth", () => ({
  getCoachRouteAuth: async () =>
    state.auth ? { convexToken: "test-only", clerkUserId: "test-only" } : null,
}));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  state.auth = true;
});
async function harness(rotated = false, shifted = false) {
  const h = await setup();
  await mkdir(".orca-scratch", { recursive: true });
  const root = await mkdtemp(path.resolve(".orca-scratch/selection-test-"));
  const scratch = path.join(root, "scratch");
  await mkdir(scratch);
  vi.stubEnv("TMPDIR", scratch);
  vi.stubEnv("SELECTION_FRAME_COUNT", "3");
  vi.stubEnv("STORAGE_DRIVER", "local");
  vi.stubEnv("LOCAL_STORAGE_DIR", path.join(root, "objects"));
  const secret = randomBytes(32).toString("hex");
  vi.stubEnv("MEDIA_URL_SIGNING_SECRET", secret);
  vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", "https://convex.invalid");
  const storage = new LocalVideoStorage({
    rootDir: path.join(root, "objects"),
    signingSecret: secret,
  });
  let foreign = false;
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    try {
      const value = await (foreign ? h.other : h.coach).query(
        makeFunctionReference<"query">(body.path),
        jsonToConvex(body.args[0]),
      );
      return Response.json({ status: "success", value: convexToJson(value) });
    } catch {
      return Response.json({ status: "error", errorMessage: "REJECTED" });
    }
  });
  const key = `sessions/${h.sessionId}/source/original`;
  const put = async (bytes: Buffer, target = key) => {
    const url = await storage.signPutUrl(target, "video/mp4", 60);
    const request = new Request(url, {
      method: "PUT",
      headers: { "Content-Type": "video/mp4" },
      body: new Uint8Array(bytes),
    });
    await storage.writeSignedPut(
      request,
      await storage.verifySignedRequest(request, target),
    );
  };
  const clip = path.join(root, "synthetic.mp4");
  await tool(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x180:rate=10",
      "-t",
      "2",
      "-an",
      "-threads",
      "1",
      "-c:v",
      "libx264",
      ...(shifted ? ["-output_ts_offset", "5"] : []),
      clip,
    ],
    AbortSignal.timeout(10000),
  );
  let selectedClip = clip;
  if (rotated) {
    selectedClip = path.join(root, "rotated.mp4");
    await tool(
      "ffmpeg",
      [
        "-v",
        "error",
        "-display_rotation:v:0",
        "90",
        "-i",
        clip,
        "-c",
        "copy",
        selectedClip,
      ],
      AbortSignal.timeout(10000),
    );
  }
  const bytes = await readFile(selectedClip);
  const source = {
    key,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  await put(bytes);
  await h.t.run((ctx) =>
    ctx.db.patch(h.uploadId, {
      storageKey: key,
      bytesTotal: bytes.length,
      bytesConfirmed: bytes.length,
      sha256: source.sha256,
    }),
  );
  const complete = () =>
    h.t.mutation(internal.uploads.complete, {
      uploadId: h.uploadId,
      coachId: h.coachId,
      verifiedBytes: bytes.length,
    });
  const call = (signal?: AbortSignal, query = "") =>
    GET(
      new Request(
        `https://web.invalid/api/sessions/${h.sessionId}/selection-frames${query}`,
        { signal },
      ),
      { params: Promise.resolve({ id: h.sessionId }) },
    );
  return {
    ...h,
    root,
    scratch,
    source,
    storage,
    bytes,
    put,
    complete,
    call,
    foreign: () => {
      foreign = true;
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
test("actual handler rejects auth, foreign, consent, incomplete, aborted and closed input before storage", async () => {
  const h = await harness();
  const open = vi.spyOn(LocalVideoStorage.prototype, "openRange");
  try {
    state.auth = false;
    expect((await h.call()).status).toBe(401);
    state.auth = true;
    expect((await h.call(undefined, "?key=forbidden")).status).toBe(400);
    expect((await h.call()).status).toBe(409);
    await h.t.run((ctx) => ctx.db.patch(h.uploadId, { status: "aborted" }));
    expect((await h.call()).status).toBe(409);
    await h.t.run((ctx) => ctx.db.patch(h.uploadId, { status: "complete" }));
    await h.t.run((ctx) =>
      ctx.db.patch(h.sessionId, { consentConfirmedAt: undefined }),
    );
    expect((await h.call()).status).toBe(409);
    await h.coach.mutation(api.sessions.confirmConsent, {
      sessionId: h.sessionId,
    });
    h.foreign();
    expect((await h.call()).status).toBe(409);
    expect(open).not.toHaveBeenCalled();
  } finally {
    await h.cleanup();
  }
});
test("real JPEGs/timestamps, cache/reload URL refresh, concurrent bound, exact once tap gate", async () => {
  const h = await harness();
  try {
    expect(await h.complete()).toBeNull();
    const first = h.call();
    // Two requests overlapping never write conflicting selection output.
    const other = await h.call();
    const response = await first;
    const successes = [response, other].filter((r) => r.status === 200);
    expect([response.status, other.status].sort()).toEqual([200, 409]);
    const body = await successes[0].json();
    expect(body.selectionFrames).toHaveLength(3);
    expect(body.selectionFrames.map((f: { ms: number }) => f.ms)).toEqual([
      0, 700, 1400,
    ]);
    expect(successes[0].headers.get("cache-control")).toBe("no-store");
    const source = await h.coach.query(api.selectionFrames.source, {
      sessionId: h.sessionId,
    });
    const frames = await extract(h.storage, source, AbortSignal.timeout(10000));
    for (const frame of frames) {
      expect([frame.width, frame.height]).toEqual([640, 360]);
      const media = await h.storage.openRange(frame.key, null);
      const chunks: Buffer[] = [];
      for await (const chunk of media.stream) chunks.push(chunk as Buffer);
      const output = path.join(h.root, `decode-${frame.idx}.jpg`);
      const { writeFile } = await import("node:fs/promises");
      await writeFile(output, Buffer.concat(chunks));
      const probe = JSON.parse(
        await tool(
          "ffprobe",
          [
            "-v",
            "error",
            "-show_entries",
            "stream=width,height",
            "-of",
            "json",
            output,
          ],
          AbortSignal.timeout(10000),
        ),
      );
      expect(probe.streams[0]).toMatchObject({ width: 640, height: 360 });
    }
    expect((await h.call()).status).toBe(200);
    await h.put(Buffer.from("corrupt-cache"), frames[0].key);
    expect((await h.call()).status).toBe(200);
    const rebuilt = await h.storage.openRange(frames[0].key, null);
    const rebuiltChunks: Buffer[] = [];
    for await (const chunk of rebuilt.stream)
      rebuiltChunks.push(chunk as Buffer);
    expect(Buffer.concat(rebuiltChunks).subarray(0, 2)).toEqual(
      Buffer.from([255, 216]),
    );
    await h.storage.delete(frames[1].key);
    expect((await h.call()).status).toBe(200);
    const expired = new LocalVideoStorage({
      rootDir: path.join(h.root, "objects"),
      signingSecret: process.env.MEDIA_URL_SIGNING_SECRET!,
      now: () => Date.now() + 400000,
    });
    const url = body.selectionFrames[0].url;
    const mediaGet = (await import("../../app/api/media/local/[...key]/route"))
      .GET;
    const mediaContext = {
      params: Promise.resolve({ key: frames[0].key.split("/") }),
    };
    const mediaResponse = await mediaGet(new Request(url), mediaContext);
    expect(mediaResponse.status).toBe(200);
    expect(
      Buffer.from(await mediaResponse.arrayBuffer()).subarray(0, 2),
    ).toEqual(Buffer.from([255, 216]));
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 400000);
    expect((await mediaGet(new Request(url), mediaContext)).status).toBe(403);
    clock.mockRestore();
    await expect(
      expired.verifySignedRequest(new Request(url), frames[0].key),
    ).rejects.toThrow("INVALID_SIGNATURE");
    await h.t.run(async (ctx) => {
      for (const table of [
        "jobs",
        "stageRuns",
        "transcriptTurns",
        "annotations",
      ] as const)
        expect(await ctx.db.query(table).collect()).toHaveLength(0);
    });
    expect(
      await readdir(path.join(h.root, "objects", "sessions", h.sessionId)),
    ).toEqual(["selection", "source"]);
    const selected = { ...tap, frameMs: body.selectionFrames[1].ms };
    const job = await h.coach.mutation(api.sessions.setSubject, {
      sessionId: h.sessionId,
      ...selected,
    });
    expect(job).toBeTruthy();
    expect(
      await h.coach.mutation(api.sessions.setSubject, {
        sessionId: h.sessionId,
        ...selected,
      }),
    ).toBe(job);
    expect(await h.t.run((ctx) => ctx.db.query("jobs").collect())).toHaveLength(
      1,
    );
    expect(
      (await h.coach.query(api.sessions.get, { sessionId: h.sessionId }))
        .subject,
    ).toMatchObject({ ...selected, selectedBy: "coach" });
    expect(await readdir(h.scratch)).toEqual([]);
  } finally {
    await h.cleanup();
  }
}, 30000);
test("tampered bytes/size/symlink fail before tools; cancellation and tool failure clean scratch", async () => {
  const h = await harness();
  try {
    await h.complete();
    await h.put(Buffer.from("tampered"));
    expect((await h.call()).status).toBe(409);
    await h.put(Buffer.alloc(h.bytes.length));
    expect((await h.call()).status).toBe(409);
    await h.put(h.bytes);
    const target = path.join(h.root, "objects", h.source.key);
    await rm(target);
    await symlink(path.join(h.root, "synthetic.mp4"), target);
    expect((await h.call()).status).toBe(409);
    await rm(target);
    await h.put(h.bytes);
    const controller = new AbortController();
    const pending = h.call(controller.signal);
    controller.abort();
    expect((await pending).status).toBe(409);
    vi.stubEnv("PATH", h.root);
    expect((await h.call()).status).toBe(409);
    expect(await readdir(h.scratch)).toEqual([]);
  } finally {
    await h.cleanup();
  }
});

test("real running tool is killed and reaped on deadline; failed extraction removes private scratch", async () => {
  const h = await harness();
  const spawn = vi.mocked(processes.spawn);
  spawn.mockClear();
  try {
    const pending = tool(
      "ffmpeg",
      [
        "-v",
        "error",
        "-re",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=32x32:rate=1",
        "-f",
        "null",
        "-",
      ],
      AbortSignal.timeout(150),
    );
    await expect(pending).rejects.toThrow("SELECTION_UNAVAILABLE");
    const child = spawn.mock.results[0].value as processes.ChildProcess;
    expect(child.pid).toBeTypeOf("number");
    expect(child.signalCode).toBe("SIGKILL");
    expect(() => process.kill(child.pid!, 0)).toThrow();
    await h.complete();
    const pendingExtraction = extract(
      h.storage,
      h.source,
      AbortSignal.timeout(1),
    );
    await expect(pendingExtraction).rejects.toThrow();
    expect(await readdir(h.scratch)).toEqual([]);
  } finally {
    await h.cleanup();
  }
});

test("rotation is applied before reporting JPEG geometry and normalized tap space", async () => {
  const h = await harness(true);
  try {
    await h.complete();
    const response = await h.call();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.selectionFrames).toHaveLength(3);
    for (const frame of body.selectionFrames)
      expect([frame.width, frame.height]).toEqual([360, 640]);
    expect(await readdir(h.scratch)).toEqual([]);
  } finally {
    await h.cleanup();
  }
});

test("stalled source I/O aborts its stream and scratch; malformed media fails without publication", async () => {
  const h = await harness();
  try {
    await h.complete();
    const { Readable } = await import("node:stream");
    const stalled = new Readable({ read() {} });
    const open = vi.spyOn(h.storage, "openRange").mockResolvedValueOnce({
      stream: stalled as Awaited<
        ReturnType<LocalVideoStorage["openRange"]>
      >["stream"],
      start: 0,
      end: h.source.bytes - 1,
      size: h.source.bytes,
      partial: false,
    });
    await expect(
      extract(h.storage, h.source, AbortSignal.timeout(30)),
    ).rejects.toThrow();
    expect(stalled.destroyed).toBe(true);
    expect(await readdir(h.scratch)).toEqual([]);
    open.mockRestore();
    const invalid = Buffer.from("synthetic invalid media");
    await h.put(invalid);
    await h.t.run((ctx) =>
      ctx.db.patch(h.uploadId, {
        bytesTotal: invalid.length,
        bytesConfirmed: invalid.length,
        sha256: createHash("sha256").update(invalid).digest("hex"),
      }),
    );
    expect((await h.call()).status).toBe(409);
    expect(await readdir(h.scratch)).toEqual([]);
    expect(
      await readdir(path.join(h.root, "objects", "sessions", h.sessionId)),
    ).toEqual(["source"]);
  } finally {
    await h.cleanup();
  }
});

test("client cancellation during real handler ffmpeg reaps child before removing scratch", async () => {
  const h = await harness();
  try {
    await h.complete();
    const real =
      await vi.importActual<typeof import("node:child_process")>(
        "node:child_process",
      );
    const controller = new AbortController();
    let runningChild: processes.ChildProcess | undefined;
    vi.mocked(processes.spawn).mockImplementation(
      (...args: Parameters<typeof processes.spawn>) => {
        const child = real.spawn(...args);
        if (args[0] === "ffmpeg") {
          runningChild = child;
          child.once("spawn", () => controller.abort());
        }
        return child;
      },
    );
    expect((await h.call(controller.signal)).status).toBe(409);
    expect(runningChild?.pid).toBeTypeOf("number");
    expect(runningChild?.signalCode).toBe("SIGKILL");
    expect(() => process.kill(runningChild!.pid!, 0)).toThrow();
    expect(await readdir(h.scratch)).toEqual([]);
    expect(
      await readdir(path.join(h.root, "objects", "sessions", h.sessionId)),
    ).toEqual(["source"]);
  } finally {
    await h.cleanup();
  }
});

test("nonzero source start timestamps normalize to the same clip-relative tap timeline as transcode", async () => {
  const h = await harness(false, true);
  try {
    await h.complete();
    const response = await h.call();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(
      body.selectionFrames.map((frame: { ms: number }) => frame.ms),
    ).toEqual([0, 700, 1400]);
  } finally {
    await h.cleanup();
  }
});
