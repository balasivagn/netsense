"use client";
import { useEffect, useRef, type RefObject } from "react";
import { drawMark, visibleMarks, type Playback } from "../../lib/overlay/draw";
import type { TrackFile } from "../../../../packages/contracts/gen/TrackFile";
export function OverlayCanvas({
  video,
  data,
  tracks,
}: {
  video: RefObject<HTMLVideoElement | null>;
  data: Playback;
  tracks: Record<string, TrackFile>;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const v = video.current,
      c = canvas.current;
    if (!v || !c) return;
    let frame = 0,
      raf = 0,
      stopped = false;
    const draw = (ms: number) => {
      if (stopped) return;
      c.width = v.videoWidth || 1;
      c.height = v.videoHeight || 1;
      const ctx = c.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, c.width, c.height);
      for (const { mark, box } of visibleMarks(data, tracks, ms))
        drawMark(ctx, box, mark);
    };
    const tick = () => {
      draw(v.currentTime * 1000);
      raf = requestAnimationFrame(tick);
    };
    const next: VideoFrameRequestCallback = (_, meta) => {
      draw(meta.mediaTime * 1000);
      if (!stopped) frame = v.requestVideoFrameCallback(next);
    };
    const seek = () => draw(v.currentTime * 1000);
    v.addEventListener("seeked", seek);
    v.addEventListener("loadedmetadata", seek);
    const observer = new ResizeObserver(seek);
    observer.observe(v);
    if (v.requestVideoFrameCallback) frame = v.requestVideoFrameCallback(next);
    else raf = requestAnimationFrame(tick);
    return () => {
      stopped = true;
      if (frame) v.cancelVideoFrameCallback(frame);
      cancelAnimationFrame(raf);
      observer.disconnect();
      v.removeEventListener("seeked", seek);
      v.removeEventListener("loadedmetadata", seek);
      c.getContext("2d")?.clearRect(0, 0, c.width, c.height);
    };
  }, [video, data, tracks]);
  return (
    <canvas
      ref={canvas}
      aria-hidden
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        objectFit: "contain",
        pointerEvents: "none",
      }}
    />
  );
}
