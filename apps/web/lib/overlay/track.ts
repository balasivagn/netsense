import type { TrackFile } from "../../../../packages/contracts/gen/TrackFile";
import { validateSchema } from "../../../../packages/contracts/validateSchema";
import schema from "../../../../packages/contracts/schemas/TrackFile.json";
import common from "../../../../packages/contracts/schemas/Common.json";
// Local dereference for the single external definition; validation stays schema-derived.
const trackSchema = {
  ...schema,
  properties: {
    ...schema.properties,
    frames: {
      ...schema.properties.frames,
      items: {
        ...schema.properties.frames.items,
        properties: {
          ...schema.properties.frames.items.properties,
          box: common.$defs.Box,
        },
      },
    },
  },
};
export function validateTrack(
  value: unknown,
  width: number,
  height: number,
  duration: number,
): TrackFile {
  if (!validateSchema(trackSchema, value)) throw Error("INVALID_TRACK");
  const t = value as TrackFile;
  if (
    !Number.isFinite(t.fps) ||
    t.fps > 120 ||
    !t.frames.length ||
    (t.fps === 0 && t.frames.length !== 1)
  )
    throw Error("INVALID_TRACK");
  let last = -1;
  for (const f of t.frames) {
    const b = f.box;
    if (!(
      last < f.ms &&
      f.ms < duration &&
      0 <= b.x1 &&
      b.x1 < b.x2 &&
      b.x2 <= width &&
      0 <= b.y1 &&
      b.y1 < b.y2 &&
      b.y2 <= height
    ))
      throw Error("INVALID_TRACK");
    last = f.ms;
  }
  last = -1;
  for (const [a, b] of t.gaps) {
    if (!(0 <= a && a < b && b <= duration && a >= last))
      throw Error("INVALID_TRACK");
    last = b;
  }
  last = -1;
  for (const s of t.swaps) {
    if (!(last < s.ms && s.ms < duration)) throw Error("INVALID_TRACK");
    last = s.ms;
  }
  return t;
}
export function boxAt(t: TrackFile, ms: number) {
  if (t.swaps.length && t.swaps[0].ms <= ms) return null;
  let lo = 0,
    hi = t.frames.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (t.frames[mid].ms < ms) lo = mid + 1;
    else hi = mid;
  }
  return (
    t.frames
      .slice(Math.max(0, lo - 1), lo + 1)
      .filter((f) => {
        if (t.fps === 0 ? f.ms !== ms : Math.abs(f.ms - ms) > 500 / t.fps)
          return false;
        const left = Math.min(f.ms, ms),
          right = Math.max(f.ms, ms);
        return (
          !(t.swaps.length && t.swaps[0].ms <= right) &&
          !t.gaps.some(([a, b]) => a <= right && b > left)
        );
      })
      .sort(
        (a, b) => Math.abs(a.ms - ms) - Math.abs(b.ms - ms) || a.ms - b.ms,
      )[0]?.box ?? null
  );
}
