import type { SelectionFrame } from "../../components/subject-picker/frame-scrubber";

function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(Error("SELECTION_UNAVAILABLE"));
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key))
  )
    throw Error("SELECTION_UNAVAILABLE");
  return value as Record<string, unknown>;
}
export async function loadSelectionFrames(
  sessionId: string,
  signal: AbortSignal,
  options: { fetcher?: typeof fetch; timeoutMs?: number } = {},
): Promise<SelectionFrame[]> {
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal]);
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? 100000,
  );
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    combined.throwIfAborted();
    const response = await bounded(
      (options.fetcher ?? fetch)(
        `/api/sessions/${encodeURIComponent(sessionId)}/selection-frames`,
        {
          signal: combined,
          cache: "no-store",
          credentials: "same-origin",
          redirect: "error",
        },
      ).then((response) => {
        if (combined.aborted) {
          void response.body?.cancel().catch(() => undefined);
          throw Error("SELECTION_UNAVAILABLE");
        }
        return response;
      }),
      combined,
    );
    reader = response.body?.getReader();
    if (!response.ok || !reader) throw Error("SELECTION_UNAVAILABLE");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const next = await bounded(reader.read(), combined);
      if (next.done) break;
      bytes += next.value.length;
      if (bytes > 32768 || chunks.length >= 32768)
        throw Error("SELECTION_UNAVAILABLE");
      chunks.push(next.value);
    }
    const all = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      all.set(chunk, offset);
      offset += chunk.length;
    }
    const body = object(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(all)),
      ["selectionFrames"],
    );
    if (
      !Array.isArray(body.selectionFrames) ||
      body.selectionFrames.length < 1 ||
      body.selectionFrames.length > 24
    )
      throw Error("SELECTION_UNAVAILABLE");
    let previousMs = -1;
    return body.selectionFrames.map((value: unknown, index: number) => {
      const frame = object(value, ["idx", "ms", "width", "height", "url"]);
      const { idx, ms, width, height, url } = frame;
      if (
        idx !== index ||
        typeof ms !== "number" ||
        !Number.isSafeInteger(ms) ||
        ms <= previousMs ||
        ms > 600000 ||
        typeof width !== "number" ||
        !Number.isSafeInteger(width) ||
        width < 1 ||
        width > 640 ||
        typeof height !== "number" ||
        !Number.isSafeInteger(height) ||
        height < 1 ||
        height > 640 ||
        typeof url !== "string" ||
        url.length > 8192
      )
        throw Error("SELECTION_UNAVAILABLE");
      const parsed = new URL(url);
      if (
        !["http:", "https:"].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password ||
        parsed.hash ||
        !parsed.pathname.startsWith(
          `/api/media/local/sessions/${encodeURIComponent(sessionId)}/selection/`,
        )
      )
        throw Error("SELECTION_UNAVAILABLE");
      previousMs = ms;
      return { idx: index, ms, url };
    });
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) {
      void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
}
