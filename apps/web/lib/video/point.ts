export type NormalizedPoint = { x: number; y: number };

export type Rectangle = { left: number; top: number; width: number; height: number };

export function containedImageRect(
  container: Rectangle,
  intrinsicWidth: number,
  intrinsicHeight: number,
): Rectangle | null {
  if (
    ![container.left, container.top, container.width, container.height, intrinsicWidth, intrinsicHeight].every(Number.isFinite) ||
    container.width <= 0 ||
    container.height <= 0 ||
    intrinsicWidth <= 0 ||
    intrinsicHeight <= 0
  ) {
    return null;
  }

  const scale = Math.min(container.width / intrinsicWidth, container.height / intrinsicHeight);
  const width = intrinsicWidth * scale;
  const height = intrinsicHeight * scale;
  return {
    left: container.left + (container.width - width) / 2,
    top: container.top + (container.height - height) / 2,
    width,
    height,
  };
}

export function normalizePointInContainedImage(
  clientX: number,
  clientY: number,
  container: Rectangle,
  intrinsicWidth: number,
  intrinsicHeight: number,
): NormalizedPoint | null {
  const image = containedImageRect(container, intrinsicWidth, intrinsicHeight);
  if (image === null || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;

  const x = (clientX - image.left) / image.width;
  const y = (clientY - image.top) / image.height;
  const epsilon = 1e-7;
  if (x < -epsilon || x > 1 + epsilon || y < -epsilon || y > 1 + epsilon) return null;

  return {
    x: Math.min(1, Math.max(0, x)),
    y: Math.min(1, Math.max(0, y)),
  };
}
