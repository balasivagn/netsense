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
  target: EventTarget,
  success: string,
  failure: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (callback: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      target.removeEventListener(success, onSuccess);
      target.removeEventListener(failure, onFailure);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onSuccess = () => finish(resolve);
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
    target.addEventListener(success, onSuccess, { once: true });
    target.addEventListener(failure, onFailure, { once: true });
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function grabFrame(
  file: File,
  requestedMs: number,
  options: { signal?: AbortSignal; timeoutMs?: number; mediaDom?: MediaDom } = {},
): Promise<GrabbedFrame> {
  const dom = options.mediaDom ?? browserMediaDom;
  const timeoutMs = options.timeoutMs ?? 8_000;
  let sourceUrl: string | null = null;
  let video: HTMLVideoElement | null = null;

  try {
    sourceUrl = dom.createObjectURL(file);
    video = dom.createVideo();
    video.muted = true;
    video.preload = "auto";
    video.src = sourceUrl;
    video.load();
    await waitFor(video, "loadedmetadata", "error", options.signal, timeoutMs);

    const durationMs = Math.round(video.duration * 1000);
    if (!Number.isFinite(durationMs) || durationMs < 0 || video.videoWidth <= 0 || video.videoHeight <= 0) {
      throw new Error("The video does not contain a usable frame.");
    }
    const frameMs = Math.min(durationMs, Math.max(0, Math.round(requestedMs)));
    video.currentTime = frameMs / 1000;
    await waitFor(video, "seeked", "error", options.signal, timeoutMs);

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
