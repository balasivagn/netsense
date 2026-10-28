import { describe, expect, it } from "vitest";
import { containedImageRect, normalizePointInContainedImage } from "./point";

describe("normalizePointInContainedImage", () => {
  it("normalizes a landscape image within its displayed rectangle", () => {
    expect(normalizePointInContainedImage(100, 100, { left: 0, top: 0, width: 200, height: 200 }, 400, 200)).toEqual({ x: 0.5, y: 0.5 });
  });

  it("normalizes a portrait image and rejects the letterbox", () => {
    expect(normalizePointInContainedImage(100, 100, { left: 0, top: 0, width: 200, height: 200 }, 100, 200)).toEqual({ x: 0.5, y: 0.5 });
    expect(normalizePointInContainedImage(25, 100, { left: 0, top: 0, width: 200, height: 200 }, 100, 200)).toBeNull();
  });

  it("uses the resized container rather than a prior viewport size", () => {
    expect(normalizePointInContainedImage(150, 75, { left: 50, top: 25, width: 200, height: 100 }, 400, 200)).toEqual({ x: 0.5, y: 0.5 });
  });

  it("only clamps tiny floating point rounding at the frame edge", () => {
    expect(normalizePointInContainedImage(200.00000001, 100, { left: 0, top: 0, width: 200, height: 100 }, 200, 100)).toEqual({ x: 1, y: 1 });
    expect(normalizePointInContainedImage(201, 100, { left: 0, top: 0, width: 200, height: 100 }, 200, 100)).toBeNull();
    expect(containedImageRect({ left: 0, top: 0, width: 200, height: 100 }, 200, 100)).toEqual({ left: 0, top: 0, width: 200, height: 100 });
  });
});

it("rejects non-finite pointer and image measurements", () => {
  const rect = { left: 0, top: 0, width: 200, height: 100 };
  expect(normalizePointInContainedImage(NaN, 50, rect, 200, 100)).toBeNull();
  expect(containedImageRect(rect, Infinity, 100)).toBeNull();
  expect(containedImageRect({ ...rect, left: NaN }, 200, 100)).toBeNull();
});
