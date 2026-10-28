"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { api } from "../../../../convex/_generated/api";
import { Screen06CaptureControls } from "../capture/screen06-capture-controls";
import { loadSelectionFrames } from "../../lib/selection-frames/client";
import type { SelectionFrame } from "../subject-picker/frame-scrubber";
import { SubjectPicker } from "../subject-picker/subject-picker";
import { useSessionFlow } from "./session-context";
import styles from "./sessions.module.css";
function useActive() {
  const active = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  return active;
}
export function RecordSession() {
  const { flow, state, detail } = useSessionFlow();
  const confirm = useMutation(api.sessions.confirmConsent);
  const router = useRouter();
  const active = useActive();
  if (detail.upload?.status === "aborted")
    return (
      <main className={styles.screen}>
        <h1>Upload cancelled</h1>
        <Link href="/sessions/new">Start a new session</Link>
      </main>
    );
  return (
    <>
      <div className={styles.screen}>
        <Link href="/sessions">Back to Sessions</Link>
        <p>Keep your player in frame. Talk about what you see as you film.</p>
        {state.error && <p role="alert">{state.error}</p>}
      </div>
      <Screen06CaptureControls
        scopeKey={detail.id}
        uploadError={
          state.consentRequired || state.upload?.error === "CONSENT_REQUIRED"
            ? "CONSENT_REQUIRED"
            : null
        }
        onConfirmConsent={async () => {
          await confirm({ sessionId: detail.id });
        }}
        onFileSelected={async (file, mode) => {
          // Reselecting a reserved source does not change how it was captured.
          // A camera recording is normally resumed through the camera-roll picker.
          const captureMode =
            detail.upload &&
            (detail.captureMode === "camera" ||
              detail.captureMode === "camera_roll")
              ? detail.captureMode
              : mode;
          if (await flow.select(file, captureMode)) {
            if (!active.current) return;
            void flow.retry();
            router.push(`/sessions/${detail.id}/subject`);
          }
        }}
      />
    </>
  );
}
export function UploadSession() {
  const { flow, state, detail } = useSessionFlow();
  const router = useRouter();
  const [askCancel, setAskCancel] = useState(false);
  useEffect(() => {
    if (detail.job) router.replace(`/sessions/${detail.id}/status`);
  }, [detail.job, detail.id, router]);
  const upload = state.upload;
  const complete = detail.upload?.complete || upload?.phase === "complete";
  const confirmedBytes =
    upload?.confirmedBytes ?? detail.upload?.bytesConfirmed;
  const bytesTotal = upload?.bytesTotal ?? detail.upload?.bytesTotal;
  return (
    <main className={styles.screen}>
      <Link href="/sessions">Back to Sessions</Link>
      <h1>
        {complete
          ? "Upload complete"
          : detail.uploadFailures >= 3
            ? "Upload failed"
            : "Upload clip"}
      </h1>
      <p>Only you can see this draft.</p>
      {confirmedBytes !== undefined && bytesTotal !== undefined && (
        <>
          <progress
            aria-label="Confirmed upload progress"
            value={confirmedBytes}
            max={bytesTotal}
          />
          <p>
            {confirmedBytes} / {bytesTotal} bytes confirmed
          </p>
        </>
      )}
      {state.error && <p role="alert">{state.error}</p>}
      {upload?.error === "UPLOAD_CHECKSUM" && (
        <p role="alert">This isn’t the same clip</p>
      )}
      {upload?.error === "CONSENT_REQUIRED" && (
        <p role="alert">Please confirm before uploading.</p>
      )}
      {complete ? (
        <>
          <p>
            {detail.subjectSet
              ? "Waiting for processing status…"
              : "Pick who to follow before processing can start."}
          </p>
          <Link
            className={styles.primary}
            href={`/sessions/${detail.id}/subject`}
          >
            Pick who to follow
          </Link>
        </>
      ) : (
        <>
          {!state.file && (
            <p>
              Choose the clip again to resume. It must match the original clip;
              confirmed parts are kept.
            </p>
          )}
          {upload?.phase === "cancelled" ||
          detail.upload?.status === "aborted" ? (
            <div>
              <p>Upload cancelled.</p>
              <Link href="/sessions/new">Start a new session</Link>
            </div>
          ) : (
            <div className={styles.actions}>
              {state.file && (
                <>
                  <button onClick={() => flow.pause()}>Pause</button>
                  <button
                    disabled={
                      detail.uploadFailures >= 3 ||
                      [
                        "hashing",
                        "uploading",
                        "completing",
                        "cancelling",
                        "cancel_failed",
                      ].includes(upload?.phase ?? "")
                    }
                    onClick={() => void flow.retry()}
                  >
                    Retry now
                  </button>
                  <button onClick={() => setAskCancel(true)}>
                    Cancel upload
                  </button>
                </>
              )}
              <Link href={`/sessions/${detail.id}/record`}>
                Choose the clip again
              </Link>
              {state.file && (
                <Link href={`/sessions/${detail.id}/subject`}>
                  Pick who to follow
                </Link>
              )}
            </div>
          )}
          {askCancel && (
            <div role="alertdialog" aria-label="Cancel upload?">
              <p>Cancel this upload?</p>
              <button
                onClick={() => {
                  setAskCancel(false);
                  void flow.cancel();
                }}
              >
                Yes, cancel upload
              </button>
              <button onClick={() => setAskCancel(false)}>
                Keep uploading
              </button>
            </div>
          )}
        </>
      )}
    </main>
  );
}
export function SubjectSession() {
  const { flow, state, detail } = useSessionFlow();
  const setSubject = useMutation(api.sessions.setSubject);
  const router = useRouter();
  const active = useActive();
  const locked = useRef(false);
  const [confirmation, setConfirmation] = useState<
    "idle" | "pending" | "error"
  >("idle");
  const [error, setError] = useState<string>();
  const [fallback, setFallback] = useState(false);
  useEffect(() => {
    if (detail.job) router.replace(`/sessions/${detail.id}/status`);
  }, [detail.job, detail.id, router]);
  const remote = fallback || !state.file;
  const [attempt, setAttempt] = useState(0);
  const [frames, setFrames] = useState<SelectionFrame[]>();
  const [frameError, setFrameError] = useState(false);
  useEffect(() => {
    setFrames(undefined);
    setFrameError(false);
    if (!remote || !detail.upload?.complete || detail.job) return;
    const controller = new AbortController();
    void loadSelectionFrames(detail.id, controller.signal)
      .then((selectionFrames) => {
        if (!controller.signal.aborted) setFrames(selectionFrames);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFrameError(true);
      });
    return () => controller.abort();
  }, [remote, detail.id, detail.upload?.complete, detail.job, attempt]);
  if (remote && !frames)
    return (
      <main className={styles.screen}>
        <h1>Pick who to follow</h1>
        <p>Tap the player to follow. Other people in the video are ignored.</p>
        {detail.upload?.complete ? (
          frameError ? (
            <>
              <p role="alert">
                Couldn’t open selection frames. Please try again.
              </p>
              <button onClick={() => setAttempt((value) => value + 1)}>
                Try again
              </button>
            </>
          ) : (
            <p role="status">Preparing selection frames…</p>
          )
        ) : (
          <p>
            Finish uploading to choose a frame. Processing waits for your tap.
          </p>
        )}
        <div className={styles.actions}>
          <Link href={`/sessions/${detail.id}/record`}>
            Choose the clip again
          </Link>
          <Link href={`/sessions/${detail.id}/upload`}>Upload status</Link>
        </div>
      </main>
    );
  if (!remote && !state.sourceVerified)
    return (
      <main className={styles.screen}>
        <h1>Checking your clip</h1>
        <p>Choose the same source clip to resume and pick your player.</p>
        <Link href={`/sessions/${detail.id}/upload`}>Upload status</Link>
      </main>
    );
  return (
    <>
      <SubjectPicker
        file={remote ? undefined : state.file}
        selectionFrames={remote ? frames : undefined}
        role={detail.subjectRole}
        confirmationState={confirmation}
        confirmationError={error}
        onConfirm={async (tap) => {
          if (locked.current) return;
          locked.current = true;
          setConfirmation("pending");
          setError(undefined);
          try {
            const jobId = await setSubject({ sessionId: detail.id, ...tap });
            if (active.current)
              router.push(
                `/sessions/${detail.id}/${jobId ? "status" : "upload"}`,
              );
          } catch (cause) {
            if (active.current) {
              setConfirmation("error");
              setError(
                cause instanceof Error &&
                  cause.message.includes("JOB_IN_PROGRESS")
                  ? "A job is already in progress. Check its status before changing your player."
                  : "Couldn’t save your tap. Please try again.",
              );
            }
          } finally {
            locked.current = false;
          }
        }}
        onRetake={() => router.push(`/sessions/${detail.id}/record`)}
        onRequestPickAfterUpload={() => {
          setFallback(true);
          void flow.retry();
        }}
      />
      <div className={styles.screen}>
        {remote && (
          <button
            disabled={confirmation === "pending"}
            onClick={() => setAttempt((value) => value + 1)}
          >
            Refresh frames
          </button>
        )}
        <Link href={`/sessions/${detail.id}/upload`}>Upload status</Link>
      </div>
    </>
  );
}
