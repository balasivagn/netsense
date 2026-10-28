"use client";

import { useEffect, useState } from "react";
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
  const [request, setRequest] = useState<{ file: File | null | undefined; ms: number }>({ file, ms: 0 });
  const [decoded, setDecoded] = useState<{ file: File; requestedMs: number; frame: GrabbedFrame } | null>(null);
  const [failedFile, setFailedFile] = useState<File | null>(null);
  const [selection, setSelection] = useState<{
    file: File | null | undefined; url: string; ms: number; point: NormalizedPoint;
  } | null>(null);
  const frameMs = request.file === file ? request.ms : 0;
  const decodeFailed = !!file && failedFile === file;
  const usingRemoteFrame = decodeFailed || !file;
  const remoteFrame = selectionFrames?.find((frame) => frame.ms === frameMs) ?? selectionFrames?.[0];
  const localFrame = decoded?.file === file && decoded?.requestedMs === frameMs ? decoded.frame : null;
  const displayedFrame = usingRemoteFrame ? remoteFrame ?? null : localFrame;
  const activeFrameMs = usingRemoteFrame ? remoteFrame?.ms : localFrame?.frameMs;
  const point = selection !== null && selection.file === file && selection?.url === displayedFrame?.url && selection?.ms === activeFrameMs
    ? selection.point : null;

  useEffect(() => {
    if (!file || decodeFailed) return;
    const controller = new AbortController();
    void grabFrame(file, frameMs, { signal: controller.signal })
      .then((frame) => {
        if (!controller.signal.aborted) setDecoded({ file, requestedMs: frameMs, frame });
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailedFile(file);
      });
    return () => controller.abort();
  }, [file, frameMs, decodeFailed]);

  const changeFrame = (nextFrameMs: number) => {
    setSelection(null);
    setRequest({ file, ms: nextFrameMs });
  };
  const pending = confirmationState === "pending";
  const canConfirm = !pending && point !== null && activeFrameMs !== undefined;

  return (
    <section className="subject-picker" aria-labelledby="subject-picker-title">
      <h1 id="subject-picker-title">Pick who to follow</h1>
      <p>Tap the player to follow. Other people in the video are ignored.</p>
      <p className="subject-picker__role">Role: {roleLabel[role]}</p>

      {displayedFrame ? (
        <>
          <TapTarget alt="Selected video frame" frame={displayedFrame} disabled={pending}
            onPointChange={(nextPoint) => {
              if (activeFrameMs !== undefined) setSelection({ file, url: displayedFrame.url, ms: activeFrameMs, point: nextPoint });
            }} onUnavailable={() => setSelection(null)} point={point} />
          <p id="tap-target-help">Choose a clear frame, then tap the player.</p>
        </>
      ) : (
        <p aria-live="polite">{decodeFailed ? "This clip cannot be decoded on this device." : "Loading a frame…"}</p>
      )}

      {!usingRemoteFrame && localFrame && (
        <FrameScrubber disabled={pending} durationMs={localFrame.durationMs} frameMs={frameMs} onFrameMsChange={changeFrame} />
      )}
      {usingRemoteFrame && selectionFrames && (
        <FrameScrubber disabled={pending} frameMs={remoteFrame?.ms ?? 0} onFrameMsChange={changeFrame} selectionFrames={selectionFrames} />
      )}
      {decodeFailed && (
        <button disabled={pending || !onRequestPickAfterUpload} onClick={onRequestPickAfterUpload} type="button">Pick after upload</button>
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
          disabled={pending}
          onClick={() => {
            setSelection(null);
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
