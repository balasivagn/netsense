import type { TrackFile } from "../../../../packages/contracts/gen/TrackFile";
// Same half-open observation counting as rules/checker.py, after the shared
// TrackFile schema + renderer validator has rejected malformed observations.
export function verifyRange(
  track: TrackFile,
  start: number,
  end: number,
  minimum: number,
  mode: "tracked" | "still_frame",
  keyframe?: number,
) {
  if (
    ![start, end].every(Number.isSafeInteger) ||
    start < 0 ||
    end <= start ||
    !Number.isFinite(minimum) ||
    minimum < 0 ||
    minimum > 1 ||
    !track.subjectOnly
  )
    throw Error("INVALID_RANGE");
  if (track.swaps.some((s) => start <= s.ms && s.ms < end))
    throw Error("SUBJECT_SWAP");
  const inGap = (ms: number) => track.gaps.some(([a, b]) => a <= ms && ms < b);
  const observed = new Set(
    track.frames
      .filter((f) => start <= f.ms && f.ms < end && !inGap(f.ms))
      .map((f) => f.ms),
  );
  const expected =
    track.fps === 0 ? 1 : Math.ceil(((end - start) * track.fps) / 1000);
  if (!observed.size || Math.min(observed.size, expected) / expected < minimum)
    throw Error("LOW_COVERAGE");
  if (mode === "tracked" && track.fps === 0) throw Error("NO_VIDEO_TRACK");
  if (
    mode === "still_frame" &&
    (keyframe === undefined || !observed.has(keyframe))
  )
    throw Error("NO_KEYFRAME_OBSERVATION");
}
