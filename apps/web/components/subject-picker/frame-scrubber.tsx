"use client";

export type SelectionFrame = { idx: number; ms: number; url: string };

type FrameScrubberProps = {
  durationMs?: number;
  frameMs: number;
  selectionFrames?: readonly SelectionFrame[];
  onFrameMsChange(frameMs: number): void;
};

function formatTime(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function FrameScrubber({ durationMs, frameMs, selectionFrames, onFrameMsChange }: FrameScrubberProps) {
  if (selectionFrames && selectionFrames.length > 0) {
    return (
      <fieldset className="subject-picker__scrubber">
        <legend>Selection frames</legend>
        <div className="subject-picker__frame-list" aria-label="Selection frames">
          {selectionFrames.map((frame) => (
            <button
              className={frame.ms === frameMs ? "subject-picker__frame-choice subject-picker__frame-choice--active" : "subject-picker__frame-choice"}
              key={frame.idx}
              onClick={() => onFrameMsChange(frame.ms)}
              type="button"
            >
              {formatTime(frame.ms)}
            </button>
          ))}
        </div>
      </fieldset>
    );
  }

  if (durationMs === undefined) return null;
  return (
    <label className="subject-picker__scrubber">
      <span>Frame: {formatTime(frameMs)}</span>
      <input
        aria-label="Choose video frame"
        max={durationMs}
        min={0}
        onChange={(event) => onFrameMsChange(Number(event.currentTarget.value))}
        step={1}
        type="range"
        value={Math.min(durationMs, frameMs)}
      />
    </label>
  );
}
