export type GrabbedFrame = {
  frameMs: number;
  durationMs: number;
  width: number;
  height: number;
  url: string;
};

export type MediaDom = {
  createObjectURL(file: File): string;
  revokeObjectURL(url: string): void;
  createVideo(): HTMLVideoElement;
  createCanvas(): HTMLCanvasElement;
};

const browserMediaDom: MediaDom = {
  createObjectURL: (file) => URL.createObjectURL(file),
  revokeObjectURL: (url) => URL.revokeObjectURL(url),
  createVideo: () => document.createElement("video"),
  createCanvas: () => document.createElement("canvas"),
};

function abortError(): DOMException {
  return new DOMException("Frame decoding was cancelled.", "AbortError");
}

function waitFor(
  target: HTMLVideoElement,
  ready: () => boolean,
  events: readonly string[],
  signal: AbortSignal | undefined,
  timeoutMs: number,
  trigger?: () => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (callback: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      for (const event of events) target.removeEventListener(event, onSuccess);
      target.removeEventListener("error", onFailure);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onSuccess = () => { if (ready()) finish(resolve); };
    const onFailure = () => finish(() => reject(new Error("The video frame could not be decoded.")));
    const onAbort = () => finish(() => reject(abortError()));
    const timeout = setTimeout(
      () => finish(() => reject(new Error("Timed out while decoding the video frame."))),
      timeoutMs,
    );
    if (signal?.aborted) {
      onAbort();
      return;
    }
    for (const event of events) target.addEventListener(event, onSuccess);
    target.addEventListener("error", onFailure, { once: true });
    signal?.addEventListener("abort", onAbort, { once: true });
    try { trigger?.(); onSuccess(); } catch { onFailure(); }
  });
}

export async function grabFrame(
  file: File,
  requestedMs: number,
  options: { signal?: AbortSignal; timeoutMs?: number; mediaDom?: MediaDom } = {},
): Promise<GrabbedFrame> {
  const dom = options.mediaDom ?? browserMediaDom;
  const timeoutMs = options.timeoutMs ?? 8_000;
  if (!Number.isFinite(requestedMs) || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Invalid frame request.");
  }
  if (options.signal?.aborted) throw abortError();
  const deadline = performance.now() + timeoutMs;
  const remaining = () => Math.max(0, deadline - performance.now());
  let sourceUrl: string | null = null;
  let video: HTMLVideoElement | null = null;

  try {
    sourceUrl = dom.createObjectURL(file);
    video = dom.createVideo();
    video.muted = true;
    video.preload = "auto";
    const media = video;
    const src = sourceUrl;
    await waitFor(media, () => media.readyState >= 1, ["loadedmetadata"], options.signal, remaining(), () => {
      media.src = src;
      media.load();
    });

    const durationMs = Math.round(video.duration * 1000);
    if (!Number.isFinite(durationMs) || durationMs <= 0 || video.videoWidth <= 0 || video.videoHeight <= 0) {
      throw new Error("The video does not contain a usable frame.");
    }
    const frameMs = Math.min(Math.max(0, durationMs - 1), Math.max(0, Math.round(requestedMs)));
    const seconds = frameMs / 1000;
    await waitFor(media, () => !media.seeking && media.readyState >= 2 && Math.abs(media.currentTime - seconds) < 0.001,
      ["seeked", "loadeddata", "canplay"], options.signal, remaining(), () => {
        if (media.currentTime !== seconds) media.currentTime = seconds;
      });
    if (options.signal?.aborted) throw abortError();

    const canvas = dom.createCanvas();
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("This browser cannot draw a video frame.");
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return { frameMs, durationMs, width: canvas.width, height: canvas.height, url: canvas.toDataURL("image/jpeg") };
  } finally {
    video?.removeAttribute("src");
    video?.load();
    if (sourceUrl !== null) dom.revokeObjectURL(sourceUrl);
  }
}
