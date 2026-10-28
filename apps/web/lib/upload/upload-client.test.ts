// @vitest-environment jsdom
import { createHash, randomBytes } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import { MultipartUploadController, type UploadTransport } from "./multipart";
import type { UploadRecoveryStore } from "./resume";
import { sha256Blob } from "./sha256";
import { createUploadTransport } from "./transport";

const blob = (bytes: Uint8Array, name = "clip.mp4") => {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return Object.assign(new Blob([copy.buffer], { type: "video/mp4" }), { name });
};
const memory = (): UploadRecoveryStore => {
  const values = new Map<string, unknown>();
  return { read: (coach, session) => values.get(`${coach}/${session}`) as ReturnType<UploadRecoveryStore["read"]> ?? null, write: (coach, session, value) => values.set(`${coach}/${session}`, value), clear: (coach, session) => values.delete(`${coach}/${session}`) };
};
function fakeTransport(bytes: Uint8Array, resumeFrom: number[] = []): UploadTransport & { puts: number[]; confirms: number[]; starts: number; aborts: number } {
  const result = { puts: [] as number[], confirms: [] as number[], starts: 0, aborts: 0 };
  return Object.assign(result, {
    async initialize() { result.starts++; return { uploadId: "upload-1", partSize: 4, partCount: Math.ceil(bytes.length / 4), resumeFrom }; },
    async signParts(_: string, numbers: number[]) { return numbers.map((partNumber) => ({ partNumber, url: "https://storage.invalid/part", expiresAt: Date.now() + 60_000 })); },
    async put(_: string, part: Blob) { result.puts.push(part.size); return { etag: `etag-${result.puts.length}`, bytes: part.size }; },
    async confirm(_: string, input: { partNumber: number; etag: string; bytes: number }) { result.confirms.push(input.partNumber); return { bytesConfirmed: [...new Set([...resumeFrom, ...result.confirms])].reduce((total, n) => total + Math.min(4, bytes.length - (n - 1) * 4), 0) }; },
    async complete() { return { jobId: null }; },
    async abort() { result.aborts++; },
  });
}
function controller(bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]), transport = fakeTransport(bytes), recovery = memory()) {
  return { transport, recovery, client: new MultipartUploadController({ coachId: "coach", sessionId: "session", file: blob(bytes), transport, recovery, retryDelaysMs: [0], partConcurrency: 2 }) };
}

describe("streaming SHA-256", () => {
  test("matches known and random bytes without whole-file arrayBuffer", async () => {
    const known = new TextEncoder().encode("abc");
    expect(await sha256Blob(blob(known), { chunkSize: 1 })).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    const random = randomBytes(33_333);
    let maxSlice = 0;
    const file = { size: random.length, slice(start: number, end: number) { maxSlice = Math.max(maxSlice, end - start); return blob(random.subarray(start, end)); } };
    expect(await sha256Blob(file, { chunkSize: 1024 })).toBe(createHash("sha256").update(random).digest("hex"));
    expect(maxSlice).toBeLessThanOrEqual(1024);
  });
});

describe("MultipartUploadController", () => {
  test("uploads only authoritative missing parts, including the final partial part, with confirmed progress", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const transport = fakeTransport(bytes, [1]);
    const { client } = controller(bytes, transport);
    await client.start();
    expect(transport.puts).toEqual([4, 1]);
    expect(client.snapshot).toMatchObject({ phase: "ready_to_complete", confirmedBytes: 9, confirmedParts: [1, 2, 3] });
    expect(transport.confirms).toEqual([2, 3]);
  });
  test("does not complete before the UI explicitly asks, then returns nullable jobId", async () => {
    const { client, transport } = controller();
    const complete = vi.spyOn(transport, "complete");
    await client.start();
    expect(complete).not.toHaveBeenCalled();
    await expect(client.complete()).resolves.toEqual({ jobId: null });
    expect(complete).toHaveBeenCalledTimes(1);
  });
  test("retries a dropped PUT and confirm without double-counting confirmed progress", async () => {
    const { client, transport } = controller(new Uint8Array([1, 2, 3, 4]));
    let putAttempts = 0;
    transport.put = async (_, part) => { putAttempts++; return { etag: "etag", bytes: part.size }; };
    let confirmAttempts = 0;
    transport.confirm = async (_, input) => { if (++confirmAttempts === 1) throw Error("dropped"); return { bytesConfirmed: input.bytes }; };
    await client.start();
    expect(putAttempts).toBe(2);
    expect(confirmAttempts).toBe(2);
    expect(client.snapshot.confirmedBytes).toBe(4);
  });
  test("gets a fresh signed URL after an expired one and never reports optimistic PUT progress", async () => {
    const { client, transport } = controller(new Uint8Array([1, 2, 3, 4]));
    let signs = 0;
    transport.signParts = async (_, [partNumber]) => [{ partNumber, url: "https://storage.invalid/part", expiresAt: ++signs === 1 ? Date.now() - 1 : Date.now() + 60_000 }];
    let release!: () => void;
    transport.confirm = async (_, input) => new Promise((resolve) => { release = () => resolve({ bytesConfirmed: input.bytes }); });
    const pending = client.start();
    await vi.waitFor(() => expect(typeof release).toBe("function"));
    expect(client.snapshot.confirmedBytes).toBe(0);
    release();
    await pending;
    expect(signs).toBe(2);
    expect(client.snapshot.confirmedBytes).toBe(4);
  });
  test("pause aborts in-flight work and resume reinitializes against server progress", async () => {
    const { client, transport } = controller();
    let release!: () => void;
    transport.put = async (_, part, __, signal) => new Promise((resolve, reject) => { release = () => resolve({ etag: "etag", bytes: part.size }); signal.addEventListener("abort", () => reject(new DOMException("", "AbortError"))); });
    const pending = client.start();
    await vi.waitFor(() => expect(typeof release).toBe("function"));
    client.pause();
    await pending;
    expect(client.snapshot.phase).toBe("paused");
    transport.put = async (_, part) => ({ etag: "etag", bytes: part.size });
    await client.resume();
    expect(transport.starts).toBe(2);
  });
  test("pause during hashing prevents initialization after the stale hash resolves", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    let release!: (value: ArrayBuffer) => void;
    const delayedFile = {
      size: bytes.length, type: "video/mp4", name: "clip.mp4",
      slice() { return { arrayBuffer: () => new Promise<ArrayBuffer>((resolve) => { release = resolve; }) }; },
    };
    const transport = fakeTransport(bytes);
    const client = new MultipartUploadController({ coachId: "coach", sessionId: "session", file: delayedFile as unknown as ConstructorParameters<typeof MultipartUploadController>[0]["file"], transport, recovery: memory() });
    const pending = client.start();
    await vi.waitFor(() => expect(typeof release).toBe("function"));
    client.pause();
    release(bytes.buffer.slice(0) as ArrayBuffer);
    await pending;
    expect(client.snapshot.phase).toBe("paused");
    expect(transport.starts).toBe(0);
  });
  test("pause cancels retry backoff without detached work", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const transport = fakeTransport(bytes);
    const client = new MultipartUploadController({ coachId: "coach", sessionId: "session", file: blob(bytes), transport, recovery: memory(), retryDelaysMs: [10_000] });
    transport.signParts = async () => { throw Error("offline"); };
    const pending = client.start();
    await vi.waitFor(() => expect(client.snapshot.phase).toBe("uploading"));
    client.pause();
    await pending;
    expect(client.snapshot.phase).toBe("paused");
  });
  test("cancel is explicit, clears recovery, and stale completions cannot restart it", async () => {
    const { client, transport, recovery } = controller();
    let resolvePut!: (value: { etag: string; bytes: number }) => void;
    transport.put = async (_, part) => new Promise((resolve) => { resolvePut = resolve as (value: { etag: string; bytes: number }) => void; void part; });
    const pending = client.start();
    await vi.waitFor(() => expect(typeof resolvePut).toBe("function"));
    await client.cancel();
    resolvePut({ etag: "late", bytes: 4 });
    await pending;
    expect(client.snapshot.phase).toBe("cancelled");
    expect(transport.aborts).toBe(1);
    expect(transport.confirms).toEqual([]);
    expect(recovery.read("coach", "session")).toBeNull();
  });
  test("rejects a different re-picked file before a part PUT, and accepts the same hash after reload", async () => {
    const saved = memory();
    const first = controller(new Uint8Array([1, 2, 3, 4]), undefined, saved);
    await first.client.start();
    const same = controller(new Uint8Array([1, 2, 3, 4]), undefined, saved);
    await same.client.start();
    expect(same.transport.puts).toEqual([4]);
    const different = controller(new Uint8Array([4, 3, 2, 1]), undefined, saved);
    await different.client.start();
    expect(different.client.snapshot.error).toBe("UPLOAD_CHECKSUM");
    expect(different.transport.puts).toEqual([]);
  });
  test("fails closed for malformed responses and bounds concurrent parts", async () => {
    const bytes = new Uint8Array(20);
    const { client, transport } = controller(bytes);
    let active = 0, maximum = 0;
    transport.put = async (_, part) => { active++; maximum = Math.max(maximum, active); await Promise.resolve(); active--; return { etag: "etag", bytes: part.size }; };
    await client.start();
    expect(maximum).toBeLessThanOrEqual(2);
    const bad = controller();
    bad.transport.initialize = async () => ({ uploadId: "x", partSize: 0, partCount: 1, resumeFrom: [] });
    await bad.client.start();
    expect(bad.client.snapshot.error).toBe("INVALID_RESPONSE");
  });
  test("stops whole-upload retries after three failed starts", async () => {
    const { client, transport } = controller();
    transport.initialize = async () => { transport.starts++; throw Error("offline"); };
    await client.start(); await client.start(); await client.start(); await client.start();
    expect(client.snapshot.wholeUploadAttempts).toBe(3);
    expect(transport.starts).toBe(3);
  });
});

test("same-origin API fetches and signed PUT omit credentials and reject unsafe redirects/schemes", async () => {
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/parts")) return Response.json({ urls: [{ partNumber: 1, url: "https://bucket.invalid/one", expiresAt: Date.now() + 1_000 }] });
    if (url.startsWith("https://bucket")) return Response.json({ etag: "etag", bytes: 1 }, { headers: { ETag: "etag" } });
    return Response.json({ uploadId: "u", partSize: 1, partCount: 1, resumeFrom: [] });
  });
  const transport = createUploadTransport(fetcher);
  await transport.initialize({ sessionId: "s", fileName: "f", mimeType: "video/mp4", bytesTotal: 1, sha256: "a".repeat(64) }, new AbortController().signal);
  await transport.put("https://bucket.invalid/one", blob(new Uint8Array([1])), "video/mp4", new AbortController().signal);
  const calls = fetcher.mock.calls as unknown as [RequestInfo | URL, RequestInit?][];
  expect(calls[0][1]).toMatchObject({ credentials: "same-origin", redirect: "error" });
  expect(calls[1][1]).toMatchObject({ credentials: "omit", redirect: "error" });
  await expect(transport.put("javascript:alert(1)", blob(new Uint8Array([1])), "video/mp4", new AbortController().signal)).rejects.toThrow("INVALID_RESPONSE");
});
