import { expect, test } from "vitest";
import fixture from "../../fixtures/synthetic/contracts/utf16.json";
import { sliceCoachSpan } from "./utf16";
for (const item of fixture.valid)
  test(`UTF-16 exact copy ${item.start}:${item.end}`, () =>
    expect(sliceCoachSpan(fixture.text, item.start, item.end)).toBe(
      item.expected,
    ));
for (const item of fixture.invalid)
  test(`UTF-16 invalid boundary ${item.start}:${item.end}`, () =>
    expect(() => sliceCoachSpan(fixture.text, item.start, item.end)).toThrow(
      "INVALID_SPAN",
    ));
