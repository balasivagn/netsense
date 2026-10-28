"use client";
import Link from "next/link";
import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import styles from "./sessions.module.css";
type Session = FunctionReturnType<typeof api.coachSessions.detail>;
export function sessionTarget(s: Session) {
  if (
    s.job &&
    (s.job.status === "done" ||
      s.job.errorCode === "RENDER_FAIL" ||
      (s.job.status === "waiting_for_coach" && !s.job.errorCode))
  )
    return `/sessions/${s.id}/playback`;
  if (s.job) return `/sessions/${s.id}/status`;
  if (s.upload?.complete && !s.subjectSet) return `/sessions/${s.id}/subject`;
  if (s.upload) return `/sessions/${s.id}/upload`;
  return `/sessions/${s.id}/record`;
}
function sessionLabel(s: Session) {
  if (s.uploadFailures >= 3 && !s.upload?.complete) return "Upload failed";
  if (s.job?.status === "failed") return "Needs you";
  if (s.job?.status === "waiting_for_coach") return "Needs you";
  if (s.job?.status === "done") return "Ready to review";
  if (s.job) return s.job.coachStage;
  if (s.upload?.complete) return "Pick who to follow";
  if (s.upload?.status === "aborted") return "Upload cancelled";
  if (s.upload) return "Upload clip";
  return {
    draft: "Draft",
    uploading: "Upload clip",
    processing: "Processing",
    needs_you: "Needs you",
    review_ready: "Ready to review",
    shared: "Shared",
    failed: "Needs you",
  }[s.status];
}
// Screens 02–03. Playback/share targets remain in their owning lanes.
export function SessionList() {
  const sessions = useQuery(api.coachSessions.list, {});
  const [filter, setFilter] = useState("All");
  return (
    <main className={styles.screen}>
      <h1>Sessions</h1>
      <Link className={styles.primary} href="/sessions/new">
        + New session
      </Link>
      {!sessions ? (
        <p>Loading sessions…</p>
      ) : !sessions.length ? (
        <>
          <h2>Before you start</h2>
          <ul>
            <li>Film about 10 minutes. Keep your player in frame.</li>
            <li>Only film people who agreed to be filmed.</li>
            <li>Talk about what you see as you film.</li>
          </ul>
        </>
      ) : (
        <>
          <nav className={styles.actions} aria-label="Filter sessions">
            {["All", "Needs you", "Shared"].map((f) => (
              <button
                key={f}
                aria-pressed={filter === f}
                onClick={() => setFilter(f)}
              >
                {f}
              </button>
            ))}
          </nav>
          <ul className={styles.rows}>
            {sessions
              .filter(
                (s) =>
                  filter === "All" ||
                  (filter === "Shared"
                    ? s.status === "shared"
                    : ["needs_you", "failed", "review_ready"].includes(
                        s.status,
                      ) ||
                      (s.uploadFailures >= 3 && !s.upload?.complete) ||
                      s.job?.status === "waiting_for_coach"),
              )
              .map((s) => (
                <li key={s.id}>
                  <Link className={styles.row} href={sessionTarget(s)}>
                    <strong>{s.studentLabel}</strong>
                    <p>{sessionLabel(s)}</p>
                    {(s.status === "failed" || s.job?.status === "failed") && (
                      <span className={styles.badge}>! Fix</span>
                    )}
                    {s.renderMode === "stills" && <p>Still frames only</p>}
                    {s.isDemoFallback && (
                      <p className={styles.fallback}>Recorded run (fallback)</p>
                    )}
                  </Link>
                </li>
              ))}
          </ul>
        </>
      )}
    </main>
  );
}
