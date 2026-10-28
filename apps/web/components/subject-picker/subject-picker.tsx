"use client";

import { useEffect, useRef, useState } from "react";
import { grabFrame, type GrabbedFrame } from "../../lib/video/grab-frame";
import type { NormalizedPoint } from "../../lib/video/point";
import { FrameScrubber, type SelectionFrame } from "./frame-scrubber";
import { TapTarget } from "./tap-target";

export type SubjectRole = "batter" | "bowler" | "other";
export type SubjectSelection = { frameMs: number; point: NormalizedPoint; role: SubjectRole };
export type ConfirmationState = "idle" | "pending" | "error";

export type SubjectPickerProps = {
  file?: File | null;
  role: SubjectRole;
  selectionFrames?: readonly SelectionFrame[];
  confirmationState?: ConfirmationState;
  confirmationError?: string;
  onConfirm(selection: SubjectSelection): void;
  onRetake(): void;
  onRequestPickAfterUpload?(): void;
};

const roleLabel: Record<SubjectRole, string> = { batter: "Batter", bowler: "Bowler", other: "Player" };

// Screen 07a: the parent owns upload, authenticated persistence, and selection-frame availability.
export function SubjectPicker({
  file,
  role,
  selectionFrames,
  confirmationState = "idle",
  confirmationError,
  onConfirm,
  onRetake,
  onRequestPickAfterUpload,
}: SubjectPickerProps) {
  const [frameMs, setFrameMs] = useState(0);
  const [localFrame, setLocalFrame] = useState<GrabbedFrame | null>(null);
  const [decodeFailed, setDecodeFailed] = useState(false);
  const [point, setPoint] = useState<NormalizedPoint | null>(null);
  const requestedFallbackFor = useRef<File | null>(null);

  const remoteFrame = selectionFrames?.find((frame) => frame.ms === frameMs) ?? selectionFrames?.[0];
  const usingRemoteFrame = decodeFailed || !file;
  const activeFrameMs = usingRemoteFrame ? remoteFrame?.ms : localFrame?.frameMs;
  const displayedFrame = usingRemoteFrame && remoteFrame
    ? { url: remoteFrame.url }
    : localFrame
      ? { url: localFrame.url, width: localFrame.width, height: localFrame.height }
      : null;

  useEffect(() => {
    if (!file) {
      setLocalFrame(null);
      setDecodeFailed(false);
      setPoint(null);
      return;
    }
    const controller = new AbortController();
    setPoint(null);
    setDecodeFailed(false);
    void grabFrame(file, frameMs, { signal: controller.signal })
      .then((frame) => {
        if (!controller.signal.aborted) {
          setLocalFrame(frame);
          setFrameMs(frame.frameMs);
        }
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setLocalFrame(null);
        setDecodeFailed(true);
        if (requestedFallbackFor.current !== file) {
          requestedFallbackFor.current = file;
          onRequestPickAfterUpload?.();
        }
      });
    return () => controller.abort();
  }, [file, frameMs, onRequestPickAfterUpload]);

  useEffect(() => {
    if (usingRemoteFrame && remoteFrame && frameMs !== remoteFrame.ms) setFrameMs(remoteFrame.ms);
  }, [frameMs, remoteFrame, usingRemoteFrame]);

  const changeFrame = (nextFrameMs: number) => {
    setPoint(null);
    setFrameMs(nextFrameMs);
  };
  const pending = confirmationState === "pending";
  const canConfirm = !pending && point !== null && activeFrameMs !== undefined;

  return (
    <section className="subject-picker" aria-labelledby="subject-picker-title">
      <p className="subject-picker__eyebrow">Screen 07a</p>
      <h1 id="subject-picker-title">Pick who to follow</h1>
      <p>Tap the player to follow. Other people in the video are ignored.</p>
      <p className="subject-picker__role">Role: {roleLabel[role]}</p>

      {displayedFrame ? (
        <>
          <TapTarget alt="Selected video frame" frame={displayedFrame} onPointChange={setPoint} point={point} />
          <p id="tap-target-help">Choose a clear frame, then tap the player.</p>
        </>
      ) : (
        <p aria-live="polite">{decodeFailed ? "This clip cannot be decoded on this device." : "Loading a frame…"}</p>
      )}

      {!usingRemoteFrame && localFrame && (
        <FrameScrubber durationMs={localFrame.durationMs} frameMs={frameMs} onFrameMsChange={changeFrame} />
      )}
      {usingRemoteFrame && selectionFrames && (
        <FrameScrubber frameMs={remoteFrame?.ms ?? 0} onFrameMsChange={changeFrame} selectionFrames={selectionFrames} />
      )}
      {decodeFailed && (
        <button onClick={onRequestPickAfterUpload} type="button">Pick after upload</button>
      )}
      {confirmationError && <p role="alert">{confirmationError}</p>}
      <div className="subject-picker__actions">
        <button
          className="subject-picker__confirm"
          disabled={!canConfirm}
          onClick={() => {
            if (canConfirm && point && activeFrameMs !== undefined) onConfirm({ frameMs: activeFrameMs, point, role });
          }}
          type="button"
        >
          {pending ? "Confirming…" : "Confirm"}
        </button>
        <button
          onClick={() => {
            setPoint(null);
            onRetake();
          }}
          type="button"
        >
          Retake
        </button>
      </div>
    </section>
  );
}
