import type { TrackFile } from "../../../../packages/contracts/gen/TrackFile";
import type { FunctionReturnType } from "convex/server";
import type { api } from "../../../../convex/_generated/api";
import { boxAt } from "./track";
export type Playback = FunctionReturnType<typeof api.playback.get>;
export type Mark = Playback["annotations"][number];
export type Box = TrackFile["frames"][number]["box"];
export const halfUp = (v: number) =>
  v < 0 ? -Math.floor(-v + 0.5) : Math.floor(v + 0.5);
export function anchorPoint(b: Box, a: Mark["anchor"]): [number, number] {
  const { x1, y1, x2, y2 } = b;
  const p = {
    box_center: [(x1 + x2) / 2, (y1 + y2) / 2],
    box_top: [(x1 + x2) / 2, y1],
    box_bottom: [(x1 + x2) / 2, y2],
    box_left: [x1, (y1 + y2) / 2],
    box_right: [x2, (y1 + y2) / 2],
  }[a];
  return [halfUp(p[0]), halfUp(p[1])];
}
export function arrowGeometry(
  b: Box,
  a: Mark["anchor"],
  side: NonNullable<Mark["arrowFrom"]>,
) {
  const target = anchorPoint(b, a);
  const origin = {
    left: [halfUp(b.x1) - 36, target[1]],
    right: [halfUp(b.x2) + 36, target[1]],
    above: [target[0], halfUp(b.y1) - 36],
    below: [target[0], halfUp(b.y2) + 36],
  }[side];
  const dx = target[0] - origin[0],
    dy = target[1] - origin[1],
    len = Math.hypot(dx, dy),
    ux = dx / len,
    uy = dy / len;
  return {
    origin,
    head: [
      target,
      [
        halfUp(target[0] - 8 * ux - 5 * uy),
        halfUp(target[1] - 8 * uy + 5 * ux),
      ],
      [
        halfUp(target[0] - 8 * ux + 5 * uy),
        halfUp(target[1] - 8 * uy - 5 * ux),
      ],
    ],
  };
}
export function letterbox(
  width: number,
  height: number,
  videoWidth: number,
  videoHeight: number,
) {
  const scale = Math.min(width / videoWidth, height / videoHeight);
  return {
    scale,
    x: (width - videoWidth * scale) / 2,
    y: (height - videoHeight * scale) / 2,
  };
}
export function visibleMarks(
  data: Playback,
  tracks: Record<string, TrackFile>,
  ms: number,
) {
  if (data.subjectStatus !== "anchored") return [];
  return data.annotations.flatMap((a) => {
    const r = data.remarks.find((r) => r.id === a.remarkId);
    const binding = data.tracks.find(
      (t) =>
        t.trackId === a.trackId &&
        t.remarkId === a.remarkId &&
        t.role === data.role,
    );
    if (
      a.status === "deleted" ||
      a.status === "player_missing" ||
      a.role !== data.role ||
      !r ||
      r.mode !== "tracked" ||
      r.aboutSubject !== "yes" ||
      !binding ||
      !(a.startMs <= ms && ms < a.endMs)
    )
      return [];
    const track = tracks[binding.trackId];
    const box = track && boxAt(track, ms);
    return box ? [{ mark: a, box }] : [];
  });
}
export function drawMark(ctx: CanvasRenderingContext2D, b: Box, m: Mark) {
  const x1 = halfUp(b.x1),
    y1 = halfUp(b.y1),
    x2 = halfUp(b.x2),
    y2 = halfUp(b.y2),
    [x, y] = anchorPoint(b, m.anchor),
    dashed = m.placedBy === "ai";
  ctx.save();
  ctx.strokeStyle = "#4D672A";
  ctx.fillStyle = "#4D672A";
  ctx.lineWidth = 3;
  ctx.setLineDash(dashed ? [8, 6] : []);
  if (m.markType === "highlight") {
    ctx.fillStyle = "rgba(77,103,42,.251)";
    ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
    ctx.strokeRect(x1, y1, x2 - x1 - 1, y2 - y1 - 1);
  }
  if (m.markType === "circle") {
    const radius = Math.max(
      12,
      halfUp(Math.min(Math.max(x2 - x1, 1), Math.max(y2 - y1, 1)) * 0.18),
    );
    if (dashed) {
      ctx.setLineDash([]);
      for (let s = 0; s < 360; s += 36) {
        ctx.beginPath();
        ctx.arc(x, y, radius, (s * Math.PI) / 180, ((s + 20) * Math.PI) / 180);
        ctx.stroke();
      }
    } else {
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  if (m.markType === "arrow") {
    const g = arrowGeometry(b, m.anchor, m.arrowFrom ?? "left");
    ctx.beginPath();
    ctx.moveTo(g.origin[0], g.origin[1]);
    ctx.lineTo(x, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    g.head.forEach((p, i) =>
      i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]),
    );
    ctx.closePath();
    ctx.fill();
  }
  if (m.markType === "label") {
    let size = 14;
    ctx.font = `${size}px sans-serif`;
    while (
      size > 1 &&
      ctx.measureText(m.labelText).width + 10 >= ctx.canvas.width
    ) {
      ctx.font = `${--size}px sans-serif`;
    }
    const w = halfUp(ctx.measureText(m.labelText).width) + 10,
      h = size + 10,
      left = Math.max(0, Math.min(x1, ctx.canvas.width - w)),
      top = Math.max(0, Math.min(y1 - h - 2, ctx.canvas.height - h));
    ctx.fillRect(left, top, w, h);
    ctx.strokeStyle = "white";
    ctx.lineWidth = 2;
    ctx.strokeRect(left, top, w, h);
    ctx.fillStyle = "white";
    ctx.textBaseline = "top";
    ctx.fillText(m.labelText, left + 5, top + 5);
  }
  ctx.restore();
}
