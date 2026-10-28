// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { grabFrame, type MediaDom } from "./grab-frame";

function fakeDom(): { dom: MediaDom; video: HTMLVideoElement; revoke: ReturnType<typeof vi.fn> } {
  const video = document.createElement("video");
  Object.defineProperties(video, {
    duration: { value: 3, configurable: true },
    videoWidth: { value: 640, configurable: true },
    videoHeight: { value: 360, configurable: true },
    currentTime: {
      configurable: true,
      set() { queueMicrotask(() => video.dispatchEvent(new Event("seeked"))); },
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
      frameMs: 3000, durationMs: 3000, width: 640, height: 360, url: "data:image/jpeg;base64,frame",
    });
    expect(revoke).toHaveBeenCalledWith("blob:frame");
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
