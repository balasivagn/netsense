// @vitest-environment node
import { expect, test, vi } from "vitest";
import { loadSelectionFrames } from "./client";
const frame = {
  idx: 0,
  ms: 0,
  width: 400,
  height: 200,
  url: "https://media.invalid/api/media/local/sessions/synthetic/selection/frame.jpg",
};
const signal = () => new AbortController().signal;
const fetcher = (value: unknown) => vi.fn(async () => Response.json(value));

test("selection client accepts the closed server wire and uses credentialed non-redirecting GET", async () => {
  const get = fetcher({ selectionFrames: [frame] });
  expect(
    await loadSelectionFrames("synthetic", signal(), { fetcher: get }),
  ).toEqual([{ idx: 0, ms: 0, url: frame.url }]);
  expect(get).toHaveBeenCalledWith(
    "/api/sessions/synthetic/selection-frames",
    expect.objectContaining({
      credentials: "same-origin",
      redirect: "error",
      cache: "no-store",
    }),
  );
});

test("malformed frame metadata and foreign source paths never reach the picker", async () => {
  for (const value of [
    {},
    { selectionFrames: [] },
    { selectionFrames: [frame], extra: true },
    {
      selectionFrames: Array.from({ length: 25 }, (_, idx) => ({
        ...frame,
        idx,
        ms: idx,
      })),
    },
    ...[
      { ms: -1 },
      { ms: 1.1 },
      { ms: 600001 },
      { idx: 2 },
      { width: 0 },
      { height: 641 },
      { extra: true },
      { url: "javascript:alert(1)" },
      {
        url: "https://media.invalid/api/media/local/sessions/foreign/selection/a.jpg",
      },
    ].map((change) => ({ selectionFrames: [{ ...frame, ...change }] })),
    { selectionFrames: [frame, { ...frame, idx: 1 }] },
  ])
    await expect(
      loadSelectionFrames("synthetic", signal(), { fetcher: fetcher(value) }),
    ).rejects.toThrow();
});

test("oversized and stalled bodies are bounded and cancelled", async () => {
  for (const oversized of [true, false]) {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        if (oversized) controller.enqueue(new Uint8Array(32769));
      },
      cancel,
    });
    await expect(
      loadSelectionFrames("synthetic", signal(), {
        fetcher: async () => new Response(body),
        timeoutMs: 50,
      }),
    ).rejects.toThrow();
    expect(cancel).toHaveBeenCalledOnce();
  }
});

test("stalled headers and caller cancellation finish without waiting for fetch", async () => {
  const get = vi.fn(() => new Promise<Response>(() => undefined));
  await expect(
    loadSelectionFrames("synthetic", signal(), { fetcher: get, timeoutMs: 50 }),
  ).rejects.toThrow();
  const controller = new AbortController();
  const pending = loadSelectionFrames("synthetic", controller.signal, {
    fetcher: get,
  });
  controller.abort();
  await expect(pending).rejects.toThrow();
  const already = vi.fn(() => new Promise<Response>(() => undefined));
  await expect(
    loadSelectionFrames("synthetic", controller.signal, { fetcher: already }),
  ).rejects.toThrow();
  expect(already).not.toHaveBeenCalled();
});

test("late headers after cancellation discard their response body", async () => {
  let finish!: (response: Response) => void;
  const fetcher = () =>
    new Promise<Response>((resolve) => {
      finish = resolve;
    });
  const controller = new AbortController();
  const pending = loadSelectionFrames("synthetic", controller.signal, {
    fetcher,
  });
  controller.abort();
  await expect(pending).rejects.toThrow();
  const cancel = vi.fn();
  finish(new Response(new ReadableStream({ cancel })));
  await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
});
