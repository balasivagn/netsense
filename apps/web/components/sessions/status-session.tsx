"use client";
import Link from "next/link";
import { CoachStages } from "../coach-stages";
import { useSessionFlow } from "./session-context";
import styles from "./sessions.module.css";
const messages: Record<string, string> = {
  AUDIO_DECODE: "We couldn’t read the audio. Your video is safe.",
  TRANSCRIBE_FAILED: "We couldn’t transcribe your remarks. Your video is safe.",
  NO_SPEECH: "No speech found. Your video is safe.",
  SEG_NO_TRACK: "Tracking failed. Your remarks are kept.",
  SUBJECT_NEEDED: "Pick who to follow before processing can continue.",
  SUBJECT_NOT_FOUND:
    "Your selected player could not be found at this moment. Other remarks can continue.",
  SUBJECT_SWAP:
    "Tracking may have followed someone else at this moment. Other remarks can continue.",
  RENDER_FAIL: "We couldn’t prepare the preview.",
};
export function StatusSession() {
  const { detail } = useSessionFlow();
  const job = detail.job;
  if (!job)
    return (
      <main className={styles.screen}>
        <h1>Waiting for your clip and player</h1>
        <p>
          Processing starts only after upload completes and you pick who to
          follow.
        </p>
        <Link
          href={`/sessions/${detail.id}/${detail.upload?.complete ? "subject" : "upload"}`}
        >
          Continue
        </Link>
      </main>
    );
  return (
    <>
      <CoachStages
        coachStages={job.coachStages}
        job={job}
        terminalState={
          job.errorCode || job.status === "failed" ? "action_needed" : undefined
        }
        renderTerminal={() => (
          <section role="alert">
            <h2>Needs you</h2>
            <p>
              {(job.errorCode && messages[job.errorCode]) ||
                "This draft needs attention."}
            </p>
            <p>Recovery actions are not available in this build yet.</p>
          </section>
        )}
      />
      {(job.status === "done" || job.status === "waiting_for_coach") &&
        !job.errorCode && (
          <div className={styles.screen}>
            <p>
              Processing has finished. Playback is not available in this build
              yet.
            </p>
            {/* Completion target: /sessions/[id]/playback, supplied by the playback lane. */}
          </div>
        )}
      {detail.isDemoFallback && (
        <p className={styles.fallback}>Recorded run (fallback)</p>
      )}
    </>
  );
}
