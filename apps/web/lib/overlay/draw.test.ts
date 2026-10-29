import { expect, test } from "vitest";
import fixture from "../../../../fixtures/synthetic/overlay-geometry.json";
import {
  anchorPoint,
  arrowGeometry,
  halfUp,
  letterbox,
  visibleMarks,
  type Mark,
  type Playback,
} from "./draw";
import { boxAt, validateTrack } from "./track";
const box = {
  x1: fixture.box[0],
  y1: fixture.box[1],
  x2: fixture.box[2],
  y2: fixture.box[3],
};
test("Python shared fixture anchors, arrows and half-up rounding match", () => {
  for (const [a, p] of Object.entries(fixture.anchor))
    expect(anchorPoint(box, a as Mark["anchor"])).toEqual(p);
  for (const [side, g] of Object.entries(fixture.arrows))
    expect(
      arrowGeometry(box, "box_center", side as NonNullable<Mark["arrowFrom"]>),
    ).toEqual(g);
  expect(halfUp(-1.5)).toBe(-2);
  expect(halfUp(1.5)).toBe(2);
  expect(letterbox(390, 390, 640, 360)).toEqual({
    scale: 390 / 640,
    x: 0,
    y: 85.3125,
  });
});
const track = {
  fps: 10,
  subjectOnly: true as const,
  frames: [
    { ms: 0, box, conf: 1 },
    { ms: 100, box, conf: 1 },
    { ms: 200, box, conf: 1 },
  ],
  gaps: [[110, 180]] as [number, number][],
  swaps: [{ ms: 200, reason: "jump" as const }],
};
test("renderer nearest observations, no interpolation across gaps, half-open marks, swaps and selected binding", () => {
  const t = validateTrack(track, 640, 360, 1000);
  expect(boxAt(t, 50)).toEqual(box);
  expect(boxAt(t, 51)).toEqual(box);
  expect(boxAt(t, 110)).toBeNull();
  expect(boxAt(t, 180)).toBeNull();
  expect(boxAt(t, 200)).toBeNull();
  expect(boxAt({ ...t, fps: 0, frames: [t.frames[0]] }, 1)).toBeNull();
  const a = {
    id: "a",
    remarkId: "r",
    role: "batter",
    trackId: "selected",
    startMs: 0,
    endMs: 100,
    status: "needs_you",
  } as Mark;
  const data = {
    subjectStatus: "anchored",
    role: "batter",
    remarks: [{ id: "r", mode: "tracked", aboutSubject: "yes" }],
    annotations: [a],
    tracks: [{ trackId: "selected", remarkId: "r", role: "batter" }],
  } as Playback;
  expect(visibleMarks(data, { selected: t }, 0)).toHaveLength(1);
  expect(visibleMarks(data, { selected: t }, 100)).toHaveLength(0);
  expect(
    visibleMarks(
      { ...data, annotations: [{ ...a, trackId: "other" }] },
      { selected: t, other: t },
      0,
    ),
  ).toHaveLength(0);
  expect(
    visibleMarks({ ...data, subjectStatus: "set" }, { selected: t }, 0),
  ).toHaveLength(0);
});
test.each([
  { ...track, subjectOnly: false },
  { ...track, fps: 0 },
  { ...track, frames: [track.frames[1], track.frames[0]] },
  { ...track, gaps: [[100, 100]] },
  { ...track, frames: [{ ...track.frames[0], box: { ...box, x2: 900 } }] },
  { ...track, swaps: [{ ms: 1000, reason: "jump" }] },
])("malformed track is rejected", (t) =>
  expect(() => validateTrack(t, 640, 360, 1000)).toThrow(),
);
