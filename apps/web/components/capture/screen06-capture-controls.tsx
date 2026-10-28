"use client";

import { useEffect, useRef, useState } from "react";

import styles from "./screen06-capture-controls.module.css";

export type CaptureMode = "camera" | "camera_roll";
export type CaptureUploadError = "CONSENT_REQUIRED" | null | undefined;

export type Screen06CaptureControlsProps = {
  /** Changes whenever the authenticated coach or session changes. */
  scopeKey: string;
  /** Persists the coach's required, session-scoped confirmation. */
  onConfirmConsent: () => Promise<void>;
  /** The parent owns upload, hashing, decoding, and any navigation that follows. */
  onFileSelected: (file: File, captureMode: CaptureMode) => void | Promise<void>;
  /** Pass the controller's current upload error here to reset stale consent. */
  uploadError?: CaptureUploadError;
};

type ConsentState = "idle" | "confirming" | "confirmed";
type FileState = "idle" | "selecting";

const consentFailureCopy = "We could not confirm this. Please try again.";
const fileFailureCopy = "We could not use that clip. Please try again.";
const consentRequiredCopy = "Please confirm before uploading.";

// Screen 06. The route owns sessions.confirmConsent and the upload controller.
export function Screen06CaptureControls(props: Screen06CaptureControlsProps) {
  // A new coach/session gets fresh state in the same render, before effects run.
  return <ScopedCaptureControls key={props.scopeKey} {...props} />;
}

function ScopedCaptureControls({
  onConfirmConsent,
  onFileSelected,
  uploadError,
}: Screen06CaptureControlsProps) {
  const cameraInput = useRef<HTMLInputElement>(null);
  const cameraRollInput = useRef<HTMLInputElement>(null);
  const live = useRef(true);
  const operation = useRef(0);
  const [consentState, setConsentState] = useState<ConsentState>("idle");
  const [fileState, setFileState] = useState<FileState>("idle");
  const [error, setError] = useState<string | null>(null);

  const invalidateOperations = () => {
    operation.current += 1;
  };

  const resetConsent = (message: string | null = null) => {
    invalidateOperations();
    setConsentState("idle");
    setFileState("idle");
    setError(message);
  };

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      invalidateOperations();
    };
  }, []);

  useEffect(() => {
    if (uploadError === "CONSENT_REQUIRED") resetConsent(consentRequiredCopy);
  }, [uploadError]);

  const consentConfirmed = consentState === "confirmed";
  const canPickFile = consentConfirmed && fileState === "idle";

  const confirmConsent = () => {
    const currentOperation = ++operation.current;
    setConsentState("confirming");
    setError(null);
    void (async () => {
      try {
        await onConfirmConsent();
        if (!live.current || operation.current !== currentOperation) return;
        setConsentState("confirmed");
      } catch {
        if (!live.current || operation.current !== currentOperation) return;
        setConsentState("idle");
        setError(consentFailureCopy);
      }
    })();
  };

  const handleConsentChange = (checked: boolean) => {
    if (!checked) {
      resetConsent();
      return;
    }
    if (consentState === "idle") confirmConsent();
  };

  const handleFileChange = (captureMode: CaptureMode) => (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    // Clearing immediately permits a deliberate selection of the same file again.
    event.currentTarget.value = "";
    if (!file || !canPickFile) return;

    const currentOperation = ++operation.current;
    setFileState("selecting");
    setError(null);
    void (async () => {
      try {
        await onFileSelected(file, captureMode);
        if (!live.current || operation.current !== currentOperation) return;
        setFileState("idle");
      } catch {
        if (!live.current || operation.current !== currentOperation) return;
        setFileState("idle");
        setError(fileFailureCopy);
      }
    })();
  };

  return (
    <section aria-labelledby="screen06-title" className={styles.screen}>
      <h1 id="screen06-title">How to record</h1>
      <div className={styles.consent}>
        <input
          checked={consentState !== "idle"}
          id="screen06-consent"
          onChange={(event) => handleConsentChange(event.currentTarget.checked)}
          type="checkbox"
        />
        <label htmlFor="screen06-consent">Everyone filmed in this clip is an adult and agreed to be filmed.</label>
      </div>

      {error && <p className={styles.error} role="alert">{error}</p>}

      <div className={styles.actions}>
        <button disabled={!canPickFile} onClick={() => cameraInput.current?.click()} type="button">Open camera</button>
        <button disabled={!canPickFile} onClick={() => cameraRollInput.current?.click()} type="button">Pick clip</button>
      </div>
      <input
        accept="video/*"
        aria-label="Open camera"
        capture="environment"
        className={styles.fileInput}
        disabled={!canPickFile}
        onChange={handleFileChange("camera")}
        ref={cameraInput}
        type="file"
      />
      <input
        accept="video/*"
        aria-label="Pick clip"
        className={styles.fileInput}
        disabled={!canPickFile}
        onChange={handleFileChange("camera_roll")}
        ref={cameraRollInput}
        type="file"
      />
    </section>
  );
}
