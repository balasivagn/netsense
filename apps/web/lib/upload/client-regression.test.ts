// @vitest-environment node
import { createHash, randomBytes } from "node:crypto";
import { expect, test, vi } from "vitest";
import {
  MultipartUploadController,
  type UploadTransport,
  type InitResponse,
} from "./multipart";
import { browserRecoveryStore, recoveryKey } from "./resume";
import { sha256Blob, IncrementalSha256 } from "./sha256";
import { createUploadTransport } from "./transport";
const signal = () => new AbortController().signal;
const file = (n = 9) => new Blob([new Uint8Array(n)], { type: "video/mp4" });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
function setup(n = 9, resumeFrom: number[] = [], concurrency = 2) {
  const confirmed = new Set(resumeFrom);
  const transport: UploadTransport = {
    initialize: vi.fn(async () => ({
      uploadId: "u",
      partSize: 4,
      partCount: Math.ceil(n / 4),
      resumeFrom,
    })),
    signParts: vi.fn(async (_, numbers) =>
      numbers.map((partNumber: number) => ({
        partNumber,
        url: "https://storage.invalid/part",
        expiresAt: Date.now() + 60_000,
      })),
    ),
    put: vi.fn(async (_, part) => ({ etag: "etag", bytes: part.size })),
    confirm: vi.fn(async (_, input) => {
      confirmed.add(input.partNumber);
      return {
        bytesConfirmed: [...confirmed].reduce(
          (sum, part) => sum + Math.min(4, n - (part - 1) * 4),
          0,
        ),
      };
    }),
    complete: vi.fn(async () => ({ jobId: null })),
    abort: vi.fn(async () => undefined),
  };
  const client = new MultipartUploadController({
    coachId: "c",
    sessionId: "s",
    file: file(n),
    transport,
    recovery: browserRecoveryStore(null),
    retryDelaysMs: [],
    partConcurrency: concurrency,
  });
  return { client, transport };
}
test("cumulative confirmations: sequential 4 then 8 and resumed final remainder", async () => {
  for (const [size, resume] of [
    [8, []],
    [9, [1]],
    [9, [3]],
  ] as [number, number[]][]) {
    const { client } = setup(size, resume, 1);
    expect(await client.start()).toMatchObject({
      phase: "ready_to_complete",
      confirmedBytes: size,
    });
  }
});
test("out-of-order cumulative responses do not regress verified progress", async () => {
  const { client, transport } = setup();
  const first = deferred<{ bytesConfirmed: number }>();
  transport.confirm = vi.fn(async (_, input) => {
    if (input.partNumber === 1) return first.promise;
    return { bytesConfirmed: input.partNumber === 2 ? 8 : 9 };
  });
  const progress: number[] = [];
  client.onEvent((event) => {
    if (event.type === "state") progress.push(event.state.confirmedBytes);
  });
  const pending = client.start();
  await vi.waitFor(() => expect(client.snapshot.confirmedParts).toContain(2));
  // The server committed part 1 first, but its smaller aggregate arrives last.
  first.resolve({ bytesConfirmed: 4 });
  expect(await pending).toMatchObject({
    phase: "ready_to_complete",
    confirmedBytes: 9,
  });
  expect(progress).toEqual([...progress].sort((a, b) => a - b));
});
for (const init of [
  { partCount: 1 },
  { partCount: 1e12 },
  { partSize: 0 },
  { partSize: 9e9 },
  { resumeFrom: [1, 1] },
  { resumeFrom: [0] },
  { resumeFrom: [4] },
  { resumeFrom: [1.5] },
])
  test(`rejects init metadata ${JSON.stringify(init)}`, async () => {
    const { client, transport } = setup(8);
    transport.initialize = async () => ({
      uploadId: "u",
      partSize: 4,
      partCount: 2,
      resumeFrom: [],
      ...init,
    });
    expect(await client.start()).toMatchObject({
      phase: "failed",
      error: "INVALID_RESPONSE",
    });
    expect(transport.put).not.toHaveBeenCalled();
  });
test("complete failure rejects and may be retried by resume; null is success only", async () => {
  const { client, transport } = setup(8);
  await client.start();
  transport.complete = async () => {
    throw Error("offline");
  };
  await expect(client.complete()).rejects.toThrow("offline");
  expect(client.snapshot.phase).toBe("failed");
});
test("failure invalidates siblings, drains start, and late PUT cannot confirm or sign another part", async () => {
  const { client, transport } = setup(12);
  const late = deferred<{ etag: string; bytes: number }>();
  let puts = 0;
  transport.put = vi.fn(async () => {
    if (++puts === 1) return late.promise;
    throw Error("offline");
  });
  expect(await client.start()).toMatchObject({ phase: "failed" });
  late.resolve({ etag: "late", bytes: 4 });
  await new Promise((r) => setTimeout(r, 0));
  expect(transport.confirm).not.toHaveBeenCalled();
  expect(transport.signParts).toHaveBeenCalledTimes(2);
});
test("cancel is synchronous, deduplicated, retry-safe on abort failure, and retains recovery", async () => {
  const { client, transport } = setup(8);
  await client.start();
  const abort = deferred<void>();
  transport.abort = vi.fn(() => abort.promise);
  const a = client.cancel(),
    b = client.cancel();
  expect(a).toBe(b);
  expect(client.snapshot.phase).toBe("cancelling");
  await expect(client.start()).rejects.toThrow("UPLOAD_TERMINAL");
  abort.resolve();
  await a;
  expect(transport.abort).toHaveBeenCalledTimes(1);
  const failed = setup(8);
  await failed.client.start();
  failed.transport.abort = async () => {
    throw Error("offline");
  };
  await expect(failed.client.cancel()).rejects.toThrow("offline");
  expect(failed.client.snapshot.phase).toBe("cancel_failed");
  failed.transport.abort = async () => undefined;
  await failed.client.cancel();
  expect(failed.client.snapshot.phase).toBe("cancelled");
});
test("cancel reconciles unknown reservation from lost in-flight init; failure stays uncertain", async () => {
  const { client, transport } = setup(8);
  const pending = deferred<InitResponse>();
  let calls = 0;
  transport.initialize = vi.fn(async () =>
    ++calls === 1
      ? pending.promise
      : { uploadId: "reserved", partSize: 4, partCount: 2, resumeFrom: [] },
  );
  const start = client.start();
  await vi.waitFor(() => expect(calls).toBe(1));
  await client.cancel();
  await start;
  expect(transport.abort).toHaveBeenCalledWith(
    "reserved",
    expect.any(AbortSignal),
  );
  pending.resolve({
    uploadId: "reserved",
    partSize: 4,
    partCount: 2,
    resumeFrom: [],
  });
  expect(transport.signParts).not.toHaveBeenCalled();
});
test("dispose is permanent and snapshots cannot be mutated", async () => {
  const { client } = setup();
  await client.start();
  expect(() => (client.snapshot.confirmedParts as number[]).push(5)).toThrow();
  client.dispose();
  await expect(client.resume()).rejects.toThrow("UPLOAD_TERMINAL");
});
test("recovery ignores closed/bounded malformed records and storage exceptions", () => {
  const storage = {
    getItem: vi.fn(),
    setItem: vi.fn(() => {
      throw Error("quota");
    }),
    removeItem: vi.fn(() => {
      throw Error("denied");
    }),
  } as unknown as Storage;
  const store = browserRecoveryStore(storage);
  const value = {
    version: 1 as const,
    sha256: "a".repeat(64),
    bytesTotal: 8,
    mimeType: "video/mp4",
    uploadId: "u",
  };
  vi.mocked(storage.getItem).mockReturnValue(
    JSON.stringify({ ...value, url: "unsafe" }),
  );
  expect(store.read("c", "s")).toBeNull();
  expect(() => store.write("c", "s", value)).not.toThrow();
  expect(() => store.clear("c", "s")).not.toThrow();
  expect(recoveryKey("c", "s")).toContain("netsense-upload-v1");
});
for (const n of [0, 1, 55, 56, 63, 64, 65, 4097])
  test(`SHA boundary ${n} with random incremental chunks`, async () => {
    const bytes = randomBytes(n),
      hash = new IncrementalSha256();
    for (let at = 0; at < n;) {
      const end = Math.min(n, at + 1 + randomBytes(1)[0]);
      hash.update(bytes.subarray(at, end));
      at = end;
    }
    const expected = createHash("sha256").update(bytes).digest("hex");
    expect(hash.digestHex()).toBe(expected);
    expect(await sha256Blob(new Blob([bytes]), { chunkSize: 13 })).toBe(
      expected,
    );
  });
test("rejects malformed file metadata, mismatched slice and already-aborted empty hashing", async () => {
  for (const n of [NaN, -1, 0, Infinity, 1.5])
    expect(
      () =>
        new MultipartUploadController({
          coachId: "c",
          sessionId: "s",
          file: { ...file(), size: n } as Blob,
          transport: setup().transport,
          recovery: browserRecoveryStore(null),
        }),
    ).toThrow();
  await expect(
    sha256Blob({ size: 5, slice: () => new Blob([new Uint8Array(1)]) }),
  ).rejects.toThrow("INVALID_BLOB");
  const abort = new AbortController();
  abort.abort();
  await expect(
    sha256Blob(new Blob(), { signal: abort.signal }),
  ).rejects.toMatchObject({ name: "AbortError" });
});
for (const value of [
  { jobId: null, unexpected: true },
  { jobId: "" },
  { jobId: "x".repeat(257) },
  { jobId: [] },
])
  test("closed complete response", async () => {
    const transport = createUploadTransport(async () => Response.json(value));
    await expect(transport.complete("u", signal())).rejects.toThrow(
      "INVALID_RESPONSE",
    );
  });
test("consent code is preserved; arbitrary server errors never leak", async () => {
  for (const [error, expected] of [
    ["CONSENT_REQUIRED", "CONSENT_REQUIRED"],
    ["private detail", "UPLOAD_REJECTED"],
  ]) {
    const transport = createUploadTransport(async () =>
      Response.json({ error }, { status: 409 }),
    );
    await expect(transport.complete("u", signal())).rejects.toThrow(expected);
  }
});
for (const url of [
  "https://user:pass@storage.invalid/a",
  "https://storage.invalid/a#fragment",
  "javascript:bad",
])
  test("unsafe signed URL rejected before fetch", async () => {
    const fetcher = vi.fn();
    await expect(
      createUploadTransport(fetcher).put(url, file(1), "video/mp4", signal()),
    ).rejects.toThrow("INVALID_RESPONSE");
    expect(fetcher).not.toHaveBeenCalled();
  });
for (const kind of ["endless", "utf8", "slow"] as const)
  test(`streamed body bounded/cancelled: ${kind}`, async () => {
    let reads = 0,
      cancelled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads++;
        if (kind === "slow") return;
        controller.enqueue(
          kind === "utf8"
            ? new TextEncoder().encode("界".repeat(12000))
            : new Uint8Array(1024),
        );
      },
      cancel() {
        cancelled++;
      },
    });
    const transport = createUploadTransport(async () => new Response(stream), {
      timeoutMs: 20,
    });
    await expect(transport.complete("u", signal())).rejects.toThrow(
      kind === "slow" ? "Upload interrupted" : "INVALID_RESPONSE",
    );
    expect(reads).toBeLessThanOrEqual(34);
    expect(cancelled).toBe(1);
  });
for (const operation of ["headers", "put", "abort"] as const)
  test(`absolute deadline and supplied signal: ${operation}`, async () => {
    const fetcher = vi.fn(() => new Promise<Response>(() => undefined));
    const transport = createUploadTransport(fetcher, {
      timeoutMs: 10,
      putTimeoutMs: 10,
    });
    const pending =
      operation === "put"
        ? transport.put(
            "https://storage.invalid/a",
            file(1),
            "video/mp4",
            signal(),
          )
        : operation === "abort"
          ? transport.abort("u", signal())
          : transport.complete("u", signal());
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    const aborted = new AbortController();
    aborted.abort();
    await expect(transport.complete("u", aborted.signal)).rejects.toMatchObject(
      { name: "AbortError" },
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

test("uncertain cancellation retains pending source identity across reload and retries abort", async () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => values.set(k, v),
    removeItem: (k: string) => values.delete(k),
  } as unknown as Storage;
  const recovery = browserRecoveryStore(storage);
  const { transport } = setup(8);
  let calls = 0;
  const pending = deferred<InitResponse>();
  transport.initialize = vi.fn(async () => {
    if (++calls === 1) return pending.promise;
    throw Error("offline");
  });
  const options = {
    coachId: "c",
    sessionId: "s",
    file: file(8),
    transport,
    recovery,
    retryDelaysMs: [],
  };
  const client = new MultipartUploadController(options);
  const start = client.start();
  await vi.waitFor(() => expect(calls).toBe(1));
  expect(recovery.read("c", "s")).toMatchObject({ bytesTotal: 8 });
  await expect(client.cancel()).rejects.toThrow("offline");
  await start;
  expect(client.snapshot.phase).toBe("cancel_failed");
  expect(recovery.read("c", "s")).not.toBeNull();
  const reloaded = new MultipartUploadController({ ...options, file: file(9) });
  transport.initialize = async () => ({
    uploadId: "reserved",
    partSize: 4,
    partCount: 2,
    resumeFrom: [],
  });
  await reloaded.cancel();
  expect(transport.abort).toHaveBeenCalledWith(
    "reserved",
    expect.any(AbortSignal),
  );
  expect(recovery.read("c", "s")).toBeNull();
  pending.resolve({
    uploadId: "reserved",
    partSize: 4,
    partCount: 2,
    resumeFrom: [],
  });
});

test("storage quota/security exceptions cannot corrupt controller success or cancellation", async () => {
  const { transport } = setup(8);
  const recovery = {
    read: () => {
      throw Error("denied");
    },
    write: () => {
      throw Error("quota");
    },
    clear: () => {
      throw Error("denied");
    },
  };
  const client = new MultipartUploadController({
    coachId: "c",
    sessionId: "s",
    file: file(8),
    transport,
    recovery,
    retryDelaysMs: [],
  });
  expect(await client.start()).toMatchObject({ phase: "ready_to_complete" });
  await client.cancel();
  expect(client.snapshot.phase).toBe("cancelled");
});

for (const value of [
  {
    urls: [
      {
        partNumber: 1,
        url: "https://storage.invalid/a",
        expiresAt: Date.now() + 60_000,
        extra: true,
      },
    ],
  },
  {
    urls: [
      {
        partNumber: 1,
        url: "https://storage.invalid/a",
        expiresAt: Date.now() + 60_000,
      },
      {
        partNumber: 1,
        url: "https://storage.invalid/b",
        expiresAt: Date.now() + 60_000,
      },
    ],
  },
  { urls: [] },
])
  test("signed response has closed entries and exact unique requested parts", async () => {
    await expect(
      createUploadTransport(async () => Response.json(value)).signParts(
        "u",
        [1],
        signal(),
      ),
    ).rejects.toThrow("INVALID_RESPONSE");
  });

test("confirm, abort and PUT enforce exact response fields", async () => {
  await expect(
    createUploadTransport(async () =>
      Response.json({ bytesConfirmed: 4, extra: true }),
    ).confirm("u", { partNumber: 1, bytes: 4, etag: "e" }, signal()),
  ).rejects.toThrow("INVALID_RESPONSE");
  await expect(
    createUploadTransport(async () => Response.json({ ok: true })).abort(
      "u",
      signal(),
    ),
  ).rejects.toThrow("INVALID_RESPONSE");
  await expect(
    createUploadTransport(async () =>
      Response.json(
        { etag: "e", bytes: 1, extra: true },
        { headers: { ETag: "e" } },
      ),
    ).put("https://storage.invalid/a", file(1), "video/mp4", signal()),
  ).rejects.toThrow("INVALID_RESPONSE");
});

for (const put of [false, true])
  test(`deadline covers combined header and body latency, put=${put}`, async () => {
    const cancelled = vi.fn();
    const fetcher: typeof fetch = async () => {
      await new Promise((r) => setTimeout(r, 10));
      return new Response(
        new ReadableStream({
          start() {
            /* A body which never supplies data. */
          },
          cancel: cancelled,
        }),
      );
    };
    const transport = createUploadTransport(fetcher, {
      timeoutMs: 25,
      putTimeoutMs: 25,
    });
    await expect(
      put
        ? transport.put(
            "https://storage.invalid/a",
            file(1),
            "video/mp4",
            signal(),
          )
        : transport.complete("u", signal()),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled).toHaveBeenCalledOnce();
  });

test("aborting while reading cancels reader and removes caller listener", async () => {
  const parent = new AbortController(),
    cancelled = vi.fn();
  const add = vi.spyOn(parent.signal, "addEventListener"),
    remove = vi.spyOn(parent.signal, "removeEventListener");
  const transport = createUploadTransport(
    async () => new Response(new ReadableStream({ cancel: cancelled })),
  );
  const pending = transport.complete("u", parent.signal);
  await new Promise((r) => setTimeout(r, 0));
  parent.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(cancelled).toHaveBeenCalledOnce();
  expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0][1]);
});

test("a transport deadline retries the part while a current upload still owns it", async () => {
  const { transport } = setup(4);
  let calls = 0;
  transport.put = vi.fn(async (_, part) => {
    if (++calls === 1)
      throw new DOMException("Upload interrupted", "AbortError");
    return { etag: "etag", bytes: part.size };
  });
  const client = new MultipartUploadController({
    coachId: "c",
    sessionId: "s",
    file: file(4),
    transport,
    recovery: browserRecoveryStore(null),
    retryDelaysMs: [0],
  });
  expect(await client.start()).toMatchObject({
    phase: "ready_to_complete",
    confirmedBytes: 4,
  });
  expect(transport.signParts).toHaveBeenCalledTimes(2);
  expect(transport.confirm).toHaveBeenCalledTimes(1);
});

test("local source cap accepts 2 GiB metadata and rejects larger files before hashing or transport", () => {
  const { transport } = setup();
  const slice = vi.fn(() => file());
  const options = {
    coachId: "c",
    sessionId: "s",
    transport,
    recovery: browserRecoveryStore(null),
  };
  const client = new MultipartUploadController({
    ...options,
    file: { size: 2 * 1024 ** 3, type: "video/mp4", slice },
  });
  expect(client.snapshot.bytesTotal).toBe(2 * 1024 ** 3);
  expect(
    () =>
      new MultipartUploadController({
        ...options,
        file: { size: 2 * 1024 ** 3 + 1, type: "video/mp4", slice },
      }),
  ).toThrow("INVALID_FILE");
  expect(slice).not.toHaveBeenCalled();
  expect(transport.initialize).not.toHaveBeenCalled();
  client.dispose();
});

test("recovery and confirmed totals honor the local 2 GiB cap", async () => {
  let stored: string | null = null;
  const recovery = browserRecoveryStore({
    getItem: () => stored,
    setItem: (_: string, value: string) => {
      stored = value;
    },
    removeItem: () => {
      stored = null;
    },
  } as unknown as Storage);
  const metadata = {
    version: 1 as const,
    sha256: "a".repeat(64),
    bytesTotal: 2 * 1024 ** 3,
    mimeType: "video/mp4",
  };
  recovery.write("c", "s", metadata);
  expect(recovery.read("c", "s")).toEqual(metadata);
  stored = JSON.stringify({ ...metadata, bytesTotal: metadata.bytesTotal + 1 });
  expect(recovery.read("c", "s")).toBeNull();
  for (const bytesConfirmed of [metadata.bytesTotal, metadata.bytesTotal + 1]) {
    const transport = createUploadTransport(async () =>
      Response.json({ bytesConfirmed }),
    );
    const result = transport.confirm(
      "u",
      { partNumber: 1, etag: "etag", bytes: 1 },
      signal(),
    );
    if (bytesConfirmed === metadata.bytesTotal) {
      await expect(result).resolves.toEqual({ bytesConfirmed });
    } else {
      await expect(result).rejects.toThrow("INVALID_RESPONSE");
    }
  }
});
