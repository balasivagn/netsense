import { validateTrack } from "../overlay/track";
export async function loadMedia(
  sessionId: string,
  asset: string,
  signal: AbortSignal,
) {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(12000)]);
  const response = await fetch("/api/media/sign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, asset }),
    signal: deadline,
    redirect: "error",
    cache: "no-store",
  });
  const reader = response.body?.getReader();
  if (!reader) throw Error("MEDIA_UNAVAILABLE");
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => void reader.cancel();
  deadline.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      const n = await reader.read();
      deadline.throwIfAborted();
      if (n.done) break;
      size += n.value.length;
      if (size > 1048576) throw Error("MEDIA_UNAVAILABLE");
      chunks.push(n.value);
    }
  } finally {
    deadline.removeEventListener("abort", abort);
    await reader.cancel();
  }
  if (!response.ok) throw Error("MEDIA_UNAVAILABLE");
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  const d = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (
    !Number.isSafeInteger(d.width) ||
    d.width < 1 ||
    d.width > 1920 ||
    !Number.isSafeInteger(d.height) ||
    d.height < 1 ||
    d.height > 1080 ||
    !Number.isSafeInteger(d.durationMs) ||
    d.durationMs < 1 ||
    d.durationMs > 1800000
  )
    throw Error("MEDIA_UNAVAILABLE");
  if (asset.startsWith("track:")) {
    if (typeof d.trackId !== "string") throw Error("MEDIA_UNAVAILABLE");
    return {
      track: validateTrack(d.track, d.width, d.height, d.durationMs),
      trackId: d.trackId,
      width: d.width as number,
      height: d.height as number,
      durationMs: d.durationMs as number,
    };
  }
  const url = new URL(d.url, location.origin);
  if (
    url.origin !== location.origin ||
    !url.pathname.startsWith(`/api/media/local/sessions/${sessionId}/`) ||
    !Number.isFinite(d.expiresAt) ||
    d.expiresAt <= Date.now()
  )
    throw Error("MEDIA_UNAVAILABLE");
  return {
    url: url.href,
    expiresAt: d.expiresAt as number,
    width: d.width as number,
    height: d.height as number,
    durationMs: d.durationMs as number,
  };
}
