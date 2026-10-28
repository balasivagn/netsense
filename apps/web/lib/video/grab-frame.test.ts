// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { grabFrame, type MediaDom } from "./grab-frame";

function fakeDom(): { dom: MediaDom; video: HTMLVideoElement; revoke: ReturnType<typeof vi.fn> } {
  const video = document.createElement("video");
  let currentTime = 0;
  Object.defineProperties(video, {
    readyState: { value: 2, configurable: true },
    duration: { value: 3, configurable: true },
    videoWidth: { value: 640, configurable: true },
    videoHeight: { value: 360, configurable: true },
    currentTime: {
      configurable: true,
      get() { return currentTime; },
      set(value: number) { currentTime = value; video.dispatchEvent(new Event("seeked")); },
    },
  });
  video.load = vi.fn(() => queueMicrotask(() => video.dispatchEvent(new Event("loadedmetadata"))));
  const revoke = vi.fn();
  const context = { drawImage: vi.fn() } as unknown as CanvasRenderingContext2D;
  const canvas = document.createElement("canvas");
  canvas.getContext = vi.fn(() => context) as unknown as typeof canvas.getContext;
  canvas.toDataURL = vi.fn(() => "data:image/jpeg;base64,frame");
  return {
    video,
    revoke,
    dom: { createObjectURL: vi.fn(() => "blob:frame"), revokeObjectURL: revoke, createVideo: () => video, createCanvas: () => canvas },
  };
}

describe("grabFrame", () => {
  it("returns an intrinsic-size frame and revokes the object URL", async () => {
    const { dom, revoke } = fakeDom();
    await expect(grabFrame(new File(["video"], "clip.mp4"), 4000, { mediaDom: dom })).resolves.toEqual({
      frameMs: 2999, durationMs: 3000, width: 640, height: 360, url: "data:image/jpeg;base64,frame",
    });
    expect(revoke).toHaveBeenCalledWith("blob:frame");
  });

  it("decodes the initial frame without waiting for a seek event", async () => {
    const { dom, video } = fakeDom();
    const seek = vi.spyOn(video, "currentTime", "set");
    await expect(grabFrame(new File(["video"], "clip.mp4"), 0, { mediaDom: dom, timeoutMs: 50 })).resolves.toMatchObject({ frameMs: 0 });
    expect(seek).not.toHaveBeenCalled();
  });

  it("handles synchronous metadata and seek events", async () => {
    const { dom, video } = fakeDom();
    Object.defineProperty(video, "readyState", { value: 0, configurable: true });
    video.load = vi.fn(() => {
      Object.defineProperty(video, "readyState", { value: 2, configurable: true });
      video.dispatchEvent(new Event("loadedmetadata"));
    });
    await expect(grabFrame(new File(["video"], "clip.mp4"), 1000, { mediaDom: dom, timeoutMs: 50 })).resolves.toMatchObject({ frameMs: 1000 });
  });

  it("waits for decoded data at zero without seeking", async () => {
    const { dom, video } = fakeDom();
    Object.defineProperty(video, "readyState", { value: 1, configurable: true });
    const result = grabFrame(new File(["video"], "clip.mp4"), 0, { mediaDom: dom });
    await Promise.resolve();
    Object.defineProperty(video, "readyState", { value: 2, configurable: true });
    video.dispatchEvent(new Event("loadeddata"));
    await expect(result).resolves.toMatchObject({ frameMs: 0 });
  });

  it("releases media after a decode timeout", async () => {
    const { dom, video, revoke } = fakeDom();
    Object.defineProperty(video, "readyState", { value: 0, configurable: true });
    await expect(grabFrame(new File(["video"], "clip.mp4"), 0, { mediaDom: dom, timeoutMs: 5 })).rejects.toThrow("Timed out");
    expect(revoke).toHaveBeenCalledOnce();
    expect(video.hasAttribute("src")).toBe(false);
  });

  it("rejects invalid requests and pre-aborted work before allocating media", async () => {
    const { dom } = fakeDom();
    const file = new File(["video"], "clip.mp4");
    await expect(grabFrame(file, NaN, { mediaDom: dom })).rejects.toThrow("Invalid");
    await expect(grabFrame(file, 0, { mediaDom: dom, timeoutMs: Infinity })).rejects.toThrow("Invalid");
    await expect(grabFrame(file, 0, { mediaDom: dom, signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
    expect(dom.createObjectURL).not.toHaveBeenCalled();
  });

  it("aborts and still revokes the object URL", async () => {
    const { dom, revoke } = fakeDom();
    dom.createVideo = () => {
      const stalledVideo = document.createElement("video");
      stalledVideo.load = vi.fn();
      return stalledVideo;
    };
    const controller = new AbortController();
    const result = grabFrame(new File(["video"], "clip.mp4"), 0, { mediaDom: dom, signal: controller.signal });
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(revoke).toHaveBeenCalledWith("blob:frame");
  });
});
