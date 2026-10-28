"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { containedImageRect, normalizePointInContainedImage, type NormalizedPoint } from "../../lib/video/point";

type TapTargetProps = {
  alt: string;
  frame: { url: string; width?: number; height?: number };
  point: NormalizedPoint | null;
  onPointChange(point: NormalizedPoint): void;
  disabled?: boolean;
  onUnavailable?(): void;
};

export function TapTarget({ alt, frame, point, onPointChange, disabled = false, onUnavailable }: TapTargetProps) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const target = useRef<HTMLDivElement>(null);
  const [bounds, setBounds] = useState({ left: 0, top: 0, width: 0, height: 0 });
  const [dimensions, setDimensions] = useState<{ url: string; width: number; height: number } | null>(null);
  useEffect(() => {
    const update = () => {
      if (target.current) setBounds(target.current.getBoundingClientRect());
    };
    update();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    if (target.current) observer?.observe(target.current);
    window.addEventListener("resize", update);
    return () => { observer?.disconnect(); window.removeEventListener("resize", update); };
  }, []);
  const imageDimensions = failedUrl === frame.url ? null : frame.width && frame.height ? frame : dimensions?.url === frame.url ? dimensions : null;
  const imageRect = imageDimensions?.width && imageDimensions.height
    ? containedImageRect(bounds, imageDimensions.width, imageDimensions.height) : null;
  const markerStyle = point && imageRect ? {
    left: `${100 * (imageRect.left - bounds.left + point.x * imageRect.width) / bounds.width}%`,
    top: `${100 * (imageRect.top - bounds.top + point.y * imageRect.height) / bounds.height}%`,
  } : undefined;

  const choosePoint = (element: HTMLElement, clientX: number, clientY: number) => {
    if (disabled || !imageDimensions?.width || !imageDimensions.height) return;
    const rect = element.getBoundingClientRect();
    setBounds(rect);
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
      aria-disabled={disabled}
      ref={target}
      className="subject-picker__tap-target"
      onKeyDown={onKeyDown}
      onPointerUp={onPointerUp}
      role="button"
      tabIndex={0}
    >
      <img
        key={frame.url}
        alt={alt}
        onLoad={(event) => { setFailedUrl(null); setDimensions({ url: frame.url, width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight }); }}
        onError={() => { setFailedUrl(frame.url); setDimensions(null); onUnavailable?.(); }}
        src={frame.url}
      />
      {markerStyle && <span aria-label="Selected player" className="subject-picker__marker" style={markerStyle} />}
    </div>
  );
}

export { containedImageRect };
