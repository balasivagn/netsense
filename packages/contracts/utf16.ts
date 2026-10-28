/** Copy a validated UTF-16 span without normalizing or inventing coach words. */
export function sliceCoachSpan(
  text: string,
  start: number,
  end: number,
): string {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end <= start ||
    end > text.length
  )
    throw Error("INVALID_SPAN");
  const splitsPair = (offset: number) =>
    offset > 0 &&
    offset < text.length &&
    text.charCodeAt(offset - 1) >= 0xd800 &&
    text.charCodeAt(offset - 1) <= 0xdbff &&
    text.charCodeAt(offset) >= 0xdc00 &&
    text.charCodeAt(offset) <= 0xdfff;
  if (splitsPair(start) || splitsPair(end)) throw Error("INVALID_SPAN");
  return text.slice(start, end);
}
