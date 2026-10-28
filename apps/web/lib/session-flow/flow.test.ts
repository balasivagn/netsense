// @vitest-environment node
import { expect, test, vi } from "vitest";
import { SessionFlow } from "./flow";
import { browserRecoveryStore } from "../upload/resume";
import type { UploadTransport } from "../upload/multipart";
import { data } from "../../../../convex/tests/helpers";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}
function harness() {
  const values = new Map<string, string>();
  const storage = {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => {
      values.set(k, v);
    },
    removeItem: (k: string) => {
      values.delete(k);
    },
  } as Storage;
  const recovery = browserRecoveryStore(storage);
  const file = new File([new Uint8Array(data.upload.bytesTotal)], "synthetic", {
    type: data.upload.mimeType,
  });
  const transport: UploadTransport = {
    initialize: vi.fn(async () => ({
      uploadId: "synthetic",
      partSize: file.size,
      partCount: 1,
      resumeFrom: [],
    })),
    signParts: vi.fn(async () => [
      {
        partNumber: 1,
        url: "https://storage.invalid/part",
        expiresAt: Date.now() + 60000,
      },
    ]),
    put: vi.fn(async () => ({ etag: data.upload.sha256, bytes: file.size })),
    confirm: vi.fn(async () => ({ bytesConfirmed: file.size })),
    complete: vi.fn(async () => ({ jobId: null })),
    abort: vi.fn(async () => {}),
  };
  const options = {
    coachId: data.identity.subject,
    sessionId: "synthetic",
    transport,
    recovery,
    selectMode: vi.fn(async () => {}),
    beginAttempt: vi.fn(async () => 1),
    failAttempt: vi.fn(async () => {}),
  };
  return { file, options, transport, values, flow: new SessionFlow(options) };
}
test("file survives consumers navigating record/upload/subject; complete can await tap", async () => {
  const h = harness();
  await h.flow.select(h.file, "camera_roll");
  const unsubscribe = h.flow.subscribe(vi.fn());
  unsubscribe();
  expect(h.flow.snapshot().file).toBe(h.file);
  await h.flow.retry();
  expect(h.options.selectMode).toHaveBeenCalledWith("camera_roll");
  expect(h.transport.complete).toHaveBeenCalledOnce();
  expect(h.flow.snapshot().upload?.phase).toBe("complete");
  expect(h.flow.snapshot().file).toBe(h.file);
  await h.flow.retry();
  expect(h.options.beginAttempt).toHaveBeenCalledOnce();
  expect(h.transport.complete).toHaveBeenCalledOnce();
  expect(h.values.size).toBe(0);
  h.flow.dispose();
  expect(h.flow.snapshot().file).toBeNull();
});
test("disposal or a newer selection invalidates pending mode persistence", async () => {
  const h = harness();
  const pending = deferred<void>();
  h.options.selectMode.mockReturnValueOnce(pending.promise);
  const old = h.flow.select(h.file, "camera");
  await h.flow.select(h.file, "camera_roll");
  pending.resolve();
  expect(await old).toBe(false);
  expect(h.flow.snapshot().file).toBe(h.file);
  const pending2 = deferred<void>();
  h.options.selectMode.mockReturnValueOnce(pending2.promise);
  const disposed = h.flow.select(h.file, "camera");
  h.flow.dispose();
  pending2.resolve();
  expect(await disposed).toBe(false);
  expect(h.flow.snapshot().file).toBeNull();
});
test("late attempt admission cannot start IO after scope disposal", async () => {
  const h = harness();
  const pending = deferred<number>();
  h.options.beginAttempt.mockReturnValue(pending.promise);
  await h.flow.select(h.file, "camera_roll");
  const run = h.flow.retry();
  h.flow.dispose();
  pending.resolve(1);
  await run;
  expect(h.transport.initialize).not.toHaveBeenCalled();
});
test("reload reselects matching source via SHA recovery and only acknowledged parts count", async () => {
  const h = harness();
  const put = deferred<{ etag: string; bytes: number }>();
  vi.mocked(h.transport.put).mockReturnValue(put.promise);
  await h.flow.select(h.file, "camera_roll");
  const first = h.flow.retry();
  await vi.waitFor(() => expect(h.transport.put).toHaveBeenCalled());
  expect(h.flow.snapshot().upload?.confirmedBytes).toBe(0);
  h.flow.pause();
  await first;
  expect(h.values.size).toBe(1);
  h.flow.dispose();
  const reloaded = new SessionFlow(h.options);
  await reloaded.select(h.file, "camera_roll");
  vi.mocked(h.transport.initialize).mockResolvedValue({
    uploadId: "synthetic",
    partSize: h.file.size,
    partCount: 1,
    resumeFrom: [1],
  });
  await reloaded.retry();
  expect(h.transport.put).toHaveBeenCalledTimes(1);
  expect(reloaded.snapshot().upload?.confirmedBytes).toBe(h.file.size);
  reloaded.dispose();
  put.resolve({ etag: data.upload.sha256, bytes: h.file.size });
  expect(h.transport.confirm).not.toHaveBeenCalled();
});
test("pending failure reports survive reload and flush before admitting retry", async () => {
  const h = harness();
  let pending: number | undefined = 1;
  const order: string[] = [];
  const flow = new SessionFlow({
    ...h.options,
    failureStore: {
      read: () => pending,
      write: (n) => {
        pending = n;
      },
    },
    failAttempt: async (n) => {
      expect(n).toBe(1);
      order.push("report");
    },
    beginAttempt: async () => {
      order.push("begin");
      return 2;
    },
  });
  await flow.select(h.file, "camera_roll");
  await flow.retry();
  expect(order).toEqual(["report", "begin"]);
  expect(pending).toBeUndefined();
  flow.dispose();
});
test("cancel invalidates late put and retains recovery if server abort fails", async () => {
  const h = harness();
  const put = deferred<{ etag: string; bytes: number }>();
  vi.mocked(h.transport.put).mockReturnValue(put.promise);
  await h.flow.select(h.file, "camera_roll");
  const run = h.flow.retry();
  await vi.waitFor(() => expect(h.transport.put).toHaveBeenCalled());
  vi.mocked(h.transport.abort).mockRejectedValueOnce(Error("offline"));
  await h.flow.cancel();
  await run;
  expect(h.flow.snapshot().upload?.phase).toBe("cancel_failed");
  expect(h.values.size).toBe(1);
  await h.flow.cancel();
  expect(h.values.size).toBe(0);
  put.resolve({ etag: data.upload.sha256, bytes: h.file.size });
  expect(h.transport.confirm).not.toHaveBeenCalled();
  h.flow.dispose();
});

test("new source selection can admit upload while stale admission is still pending", async () => {
  const h = harness();
  const pending = deferred<number>();
  h.options.beginAttempt.mockReturnValueOnce(pending.promise);
  await h.flow.select(h.file, "camera_roll");
  const old = h.flow.retry();
  await vi.waitFor(() => expect(h.options.beginAttempt).toHaveBeenCalledOnce());
  await h.flow.select(h.file, "camera_roll");
  await h.flow.retry();
  expect(h.transport.complete).toHaveBeenCalledOnce();
  pending.resolve(1);
  await old;
  expect(h.transport.complete).toHaveBeenCalledOnce();
  h.flow.dispose();
});

test("pause during attempt admission prevents later upload IO", async () => {
  const h = harness();
  const admission = deferred<number>();
  h.options.beginAttempt.mockReturnValueOnce(admission.promise);
  await h.flow.select(h.file, "camera_roll");
  const running = h.flow.retry();
  await vi.waitFor(() => expect(h.options.beginAttempt).toHaveBeenCalledOnce());
  h.flow.pause();
  admission.resolve(1);
  await running;
  expect(h.transport.initialize).not.toHaveBeenCalled();
  await h.flow.retry();
  expect(h.transport.complete).toHaveBeenCalledOnce();
  h.flow.dispose();
});
