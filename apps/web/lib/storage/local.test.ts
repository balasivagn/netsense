// @vitest-environment node
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { LocalVideoStorage, StorageError, getVideoStorage } from "./index";
import { GET, PUT } from "../../app/api/media/local/[...key]/route";

const key = "sessions/synthetic-session/source/synthetic-upload";
let root = "";
let storage: LocalVideoStorage;
let mediaSecret = "";

function secret(): string {
  return randomBytes(32).toString("base64url");
}

function context(): { params: Promise<{ key: string[] }> } {
  return { params: Promise.resolve({ key: key.split("/") }) };
}

async function put(url: string, data: Uint8Array): Promise<Response> {
  return PUT(
    new Request(url, {
      method: "PUT",
      headers: { "content-type": "video/synthetic" },
      body: data as unknown as BodyInit,
    }),
    context(),
  );
}

beforeEach(async () => {
  await mkdir(path.join(process.cwd(), ".orca-scratch"), { recursive: true });
  root = await mkdtemp(path.join(process.cwd(), ".orca-scratch", "storage-"));
  mediaSecret = secret();
  process.env.STORAGE_DRIVER = "local";
  process.env.LOCAL_STORAGE_DIR = root;
  process.env.MEDIA_URL_SIGNING_SECRET = mediaSecret;
  process.env.APP_BASE_URL = "http://storage.test";
  storage = new LocalVideoStorage({
    rootDir: root,
    signingSecret: mediaSecret,
    baseUrl: "http://storage.test",
  });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  delete process.env.STORAGE_DRIVER;
  delete process.env.LOCAL_STORAGE_DIR;
  delete process.env.MEDIA_URL_SIGNING_SECRET;
  delete process.env.APP_BASE_URL;
});

test("multipart accepts confirmed out-of-order parts and completion retries safely", async () => {
  const bytes = new Uint8Array(
    await readFile("fixtures/synthetic/storage/range.bin"),
  );
  const first = bytes.slice(0, 10),
    second = bytes.slice(10);
  const { uploadId } = await storage.initMultipart(key, "video/synthetic");
  const urls = await storage.signPartUrls(key, uploadId, [2, 1], 60);
  const secondResult = await put(urls[0].url, second);
  const firstResult = await put(urls[1].url, first);
  expect(secondResult.status).toBe(200);
  expect(firstResult.status).toBe(200);
  const parts = [
    {
      partNumber: 2,
      etag: ((await secondResult.json()) as { etag: string }).etag,
    },
    {
      partNumber: 1,
      etag: ((await firstResult.json()) as { etag: string }).etag,
    },
  ];
  await storage.completeMultipart(key, uploadId, parts);
  await storage.completeMultipart(key, uploadId, parts);
  expect(await storage.head(key)).toEqual({
    bytes: bytes.byteLength,
    contentType: "video/synthetic",
  });
  const url = await storage.signGetUrl(key, 60);
  const response = await GET(
    new Request(url, { headers: { range: "bytes=2-8" } }),
    context(),
  );
  expect(response.status).toBe(206);
  expect(response.headers.get("content-range")).toBe(
    `bytes 2-8/${bytes.byteLength}`,
  );
  expect(response.headers.get("content-length")).toBe("7");
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(
    bytes.slice(2, 9),
  );
});

test("abort is idempotent, retry starts another upload, and rejects foreign part confirmation", async () => {
  const first = await storage.initMultipart(key, "video/synthetic");
  await storage.abortMultipart(key, first.uploadId);
  await storage.abortMultipart(key, first.uploadId);
  const second = await storage.initMultipart(key, "video/synthetic");
  const [url] = await storage.signPartUrls(key, second.uploadId, [1], 60);
  const result = await put(url.url, new Uint8Array([4, 8, 15]));
  const etag = ((await result.json()) as { etag: string }).etag;
  await expect(
    storage.completeMultipart(key, second.uploadId, [
      { partNumber: 1, etag: etag.replace(/^./, "0") },
    ]),
  ).rejects.toThrow("PART_ETAG_MISMATCH");
  await expect(
    storage.completeMultipart(key, first.uploadId, [{ partNumber: 1, etag }]),
  ).rejects.toThrow("INVALID_UPLOAD_STATE");
  await expect(
    storage.signPartUrls(key, "00000000-0000-4000-8000-000000000000", [1], 60),
  ).rejects.toThrow("UNKNOWN_UPLOAD");
});

test("signed requests reject expiry, method/key tampering and wrong content type", async () => {
  const clock = 1_800_000_000_000;
  const timed = new LocalVideoStorage({
    rootDir: root,
    signingSecret: mediaSecret,
    baseUrl: "http://storage.test",
    now: () => clock,
  });
  const url = await timed.signPutUrl(key, "video/synthetic", 1);
  await expect(
    timed.verifySignedRequest(new Request(url, { method: "GET" }), key),
  ).rejects.toThrow("INVALID_SIGNATURE");
  await expect(
    timed.verifySignedRequest(
      new Request(url, {
        method: "PUT",
        headers: { "content-type": "video/other" },
      }),
      key,
    ),
  ).rejects.toThrow("INVALID_CONTENT_TYPE");
  await expect(
    timed.verifySignedRequest(
      new Request(url.replace("synthetic-upload", "other-upload"), {
        method: "PUT",
        headers: { "content-type": "video/synthetic" },
      }),
      "sessions/synthetic-session/source/other-upload",
    ),
  ).rejects.toThrow("INVALID_SIGNATURE");
  const expired = new LocalVideoStorage({
    rootDir: root,
    signingSecret: mediaSecret,
    baseUrl: "http://storage.test",
    now: () => clock + 1_000,
  });
  await expect(
    expired.verifySignedRequest(
      new Request(url, {
        method: "PUT",
        headers: { "content-type": "video/synthetic" },
      }),
      key,
    ),
  ).rejects.toThrow("INVALID_SIGNATURE");
});

test("range supports suffix and open-ended ranges and reports unsatisfiable ranges", async () => {
  const bytes = new Uint8Array(
    await readFile("fixtures/synthetic/storage/range.bin"),
  );
  const direct = await storage.signPutUrl(key, "video/synthetic", 60);
  expect((await put(direct, bytes)).status).toBe(200);
  const url = await storage.signGetUrl(key, 60);
  const suffix = await GET(
    new Request(url, { headers: { range: "bytes=-5" } }),
    context(),
  );
  expect(suffix.status).toBe(206);
  expect(new Uint8Array(await suffix.arrayBuffer())).toEqual(bytes.slice(-5));
  const openEnded = await GET(
    new Request(url, { headers: { range: "bytes=5-" } }),
    context(),
  );
  expect(openEnded.status).toBe(206);
  expect(new Uint8Array(await openEnded.arrayBuffer())).toEqual(bytes.slice(5));
  const invalid = await GET(
    new Request(url, { headers: { range: `bytes=${bytes.byteLength}-` } }),
    context(),
  );
  expect(invalid.status).toBe(416);
  expect(invalid.headers.get("content-range")).toBe(
    `bytes */${bytes.byteLength}`,
  );
});

test("keys cannot traverse or escape through symlinks and factory fails closed", async () => {
  await expect(
    storage.initMultipart(
      "sessions/synthetic-session/../outside",
      "video/synthetic",
    ),
  ).rejects.toThrow("INVALID_STORAGE_KEY");
  await expect(
    storage.initMultipart("outside/not-a-session", "video/synthetic"),
  ).rejects.toThrow("INVALID_STORAGE_KEY");
  await symlink(os.tmpdir(), path.join(root, "sessions"));
  await expect(storage.initMultipart(key, "video/synthetic")).rejects.toThrow(
    "STORAGE_SYMLINK_ESCAPE",
  );
  expect(() => getVideoStorage({ STORAGE_DRIVER: "r2" })).toThrow(
    "not implemented",
  );
  expect(() =>
    getVideoStorage({ STORAGE_DRIVER: "local", LOCAL_STORAGE_DIR: root }),
  ).toThrow("MEDIA_URL_SIGNING_SECRET");
});

test("wrong upload state is represented as a typed storage error", async () => {
  await expect(
    storage.abortMultipart(key, "00000000-0000-4000-8000-000000000000"),
  ).rejects.toBeInstanceOf(StorageError);
});

test("direct PUT preserves type, refuses overwrite, and returns private empty responses", async () => {
  const url = await storage.signPutUrl(key, "video/synthetic", 60);
  expect((await put(url, new Uint8Array())).status).toBe(200);
  expect(await storage.head(key)).toEqual({
    bytes: 0,
    contentType: "video/synthetic",
  });
  expect((await put(url, new Uint8Array())).status).toBe(409);
  const getUrl = await storage.signGetUrl(key, 60);
  const response = await GET(new Request(getUrl), context());
  expect(response.status).toBe(200);
  expect(response.headers.get("content-length")).toBe("0");
  expect(response.headers.get("content-type")).toBe("video/synthetic");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect((await response.arrayBuffer()).byteLength).toBe(0);
  const invalid = await GET(
    new Request(getUrl, { headers: { range: "bytes=0-" } }),
    context(),
  );
  expect(invalid.status).toBe(416);
  expect(invalid.headers.get("content-range")).toBe("bytes */0");
});

test("confirmed part bytes cannot change and completed manifests are immutable", async () => {
  const bytes = new Uint8Array(
    await readFile("fixtures/synthetic/storage/range.bin"),
  );
  const { uploadId } = await storage.initMultipart(key, "video/synthetic");
  const [{ url }] = await storage.signPartUrls(key, uploadId, [1], 60);
  const first = await put(url, bytes);
  const { etag } = (await first.json()) as { etag: string };
  expect((await put(url, bytes)).status).toBe(200);
  expect((await put(url, bytes.slice(1))).status).toBe(409);
  await expect(
    storage.completeMultipart(key, uploadId, [{ partNumber: 1, etag: "x" }]),
  ).rejects.toThrow("PART_ETAG_MISMATCH");
  await expect(
    storage.completeMultipart(key, uploadId, [{ partNumber: 2, etag }]),
  ).rejects.toThrow("MISSING_PART");
  await storage.completeMultipart(key, uploadId, [{ partNumber: 1, etag }]);
  const otherHash = etag.startsWith("0")
    ? `1${etag.slice(1)}`
    : `0${etag.slice(1)}`;
  await expect(
    storage.completeMultipart(key, uploadId, [
      { partNumber: 1, etag: otherHash },
    ]),
  ).rejects.toThrow("COMPLETION_CONFLICT");
});

test("concurrent completion is serialized across storage instances", async () => {
  const bytes = new Uint8Array(
    await readFile("fixtures/synthetic/storage/range.bin"),
  );
  const { uploadId } = await storage.initMultipart(key, "video/synthetic");
  const [{ url }] = await storage.signPartUrls(key, uploadId, [1], 60);
  const { etag } = (await (await put(url, bytes)).json()) as { etag: string };
  const second = new LocalVideoStorage({
    rootDir: root,
    signingSecret: mediaSecret,
  });
  await Promise.all([
    storage.completeMultipart(key, uploadId, [{ partNumber: 1, etag }]),
    second.completeMultipart(key, uploadId, [{ partNumber: 1, etag }]),
  ]);
  expect(await readFile(path.join(root, key))).toEqual(Buffer.from(bytes));
});

test("abort cannot race an in-flight PUT into resurrecting its parts", async () => {
  const bytes = new Uint8Array(
    await readFile("fixtures/synthetic/storage/range.bin"),
  );
  const { uploadId } = await storage.initMultipart(key, "video/synthetic");
  const [{ url }] = await storage.signPartUrls(key, uploadId, [1], 60);
  let completeBody!: () => void;
  let writingStarted!: () => void;
  const writing = new Promise<void>((resolve) => {
    writingStarted = resolve;
  });
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      writingStarted();
      return new Promise<void>((resolve) => {
        completeBody = () => {
          controller.enqueue(bytes);
          controller.close();
          resolve();
        };
      });
    },
  });
  const request = new Request(url, {
    method: "PUT",
    headers: { "content-type": "video/synthetic" },
    body,
    duplex: "half",
  } as RequestInit);
  const signed = await storage.verifySignedRequest(request, key);
  const inFlight = storage.writeSignedPut(request, signed);
  await writing;
  const abort = storage.abortMultipart(key, uploadId);
  completeBody();
  await Promise.all([inFlight, abort]);
  await expect(storage.partEtag(key, uploadId, 1)).rejects.toThrow(
    "MISSING_PART",
  );
  await expect(storage.signPartUrls(key, uploadId, [1], 60)).rejects.toThrow(
    "INVALID_UPLOAD_STATE",
  );
  expect(await storage.head(key)).toBeNull();
});
