"use client";

import { useEffect, useMemo, useState, type KeyboardEvent, type PointerEvent } from "react";
import { containedImageRect, normalizePointInContainedImage, type NormalizedPoint } from "../../lib/video/point";

type TapTargetProps = {
  alt: string;
  frame: { url: string; width?: number; height?: number };
  point: NormalizedPoint | null;
  onPointChange(point: NormalizedPoint): void;
};

export function TapTarget({ alt, frame, point, onPointChange }: TapTargetProps) {
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(
    frame.width && frame.height ? { width: frame.width, height: frame.height } : null,
  );
  useEffect(() => {
    setDimensions(frame.width && frame.height ? { width: frame.width, height: frame.height } : null);
  }, [frame.height, frame.url, frame.width]);
  const imageDimensions = frame.width && frame.height ? { width: frame.width, height: frame.height } : dimensions;
  const markerStyle = useMemo(() => {
    if (point === null || imageDimensions === null) return undefined;
    return { left: `${point.x * 100}%`, top: `${point.y * 100}%` };
  }, [imageDimensions, point]);

  const choosePoint = (element: HTMLElement, clientX: number, clientY: number) => {
    if (imageDimensions === null) return;
    const rect = element.getBoundingClientRect();
    const normalized = normalizePointInContainedImage(clientX, clientY, rect, imageDimensions.width, imageDimensions.height);
    if (normalized) onPointChange(normalized);
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => choosePoint(event.currentTarget, event.clientX, event.clientY);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      choosePoint(event.currentTarget, rect.left + rect.width / 2, rect.top + rect.height / 2);
    }
  };

  return (
    <div
      aria-describedby="tap-target-help"
      aria-label="Tap the player to follow"
      className="subject-picker__tap-target"
      onKeyDown={onKeyDown}
      onPointerUp={onPointerUp}
      role="button"
      tabIndex={0}
    >
      <img
        alt={alt}
        onLoad={(event) => setDimensions({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
        src={frame.url}
      />
      {markerStyle && <span aria-label="Selected player" className="subject-picker__marker" style={markerStyle} />}
    </div>
  );
}

export { containedImageRect };
