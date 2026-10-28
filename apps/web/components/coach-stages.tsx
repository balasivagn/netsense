"use client";

import type { ReactNode } from "react";
import styles from "./coach-stages.module.css";

/** The status fields Screen 12 needs from the authenticated parent query. */
export type CoachStagesJob = {
  coachStage?: string | null;
  progress?: number | null;
  progressLabel?: string | null;
  status: "queued" | "running" | "done" | "failed" | "waiting_for_coach" | "cancelled";
};

/**
 * The parent owns routing to Screens 13–16 and the render fallback treatment.
 * This component never derives either presentation from an error code.
 */
export type CoachStagesTerminalState = "action_needed" | "render_fallback";

export type CoachStagesProps = {
  /** Pinned pipeline_config.coachStages, in its supplied order. */
  coachStages: readonly string[];
  job: CoachStagesJob;
  backHref?: string;
  terminalState?: CoachStagesTerminalState;
  renderTerminal?: (state: CoachStagesTerminalState) => ReactNode;
};

type RowState = "completed" | "current" | "pending" | "needs-attention" | "waiting";

const statusCopy: Record<CoachStagesJob["status"], string> = {
  queued: "Your draft is queued.",
  running: "Your draft is being prepared.",
  done: "Your draft is ready.",
  failed: "This draft needs attention.",
  waiting_for_coach: "This draft is waiting for you.",
  cancelled: "This draft was cancelled.",
};

function validProgress(progress: CoachStagesJob["progress"]): progress is number {
  // stageRuns currently writes this as a normalised 0–1 value.
  return typeof progress === "number" && Number.isFinite(progress) && progress >= 0 && progress <= 1;
}

function rowState(job: CoachStagesJob, label: string): RowState {
  if (job.status === "done") return "completed";
  if (label !== job.coachStage) return "pending";
  if (job.status === "failed" || job.status === "cancelled") return "needs-attention";
  if (job.status === "waiting_for_coach") return "waiting";
  return "current";
}

function stateText(state: RowState) {
  return {
    completed: "Completed",
    current: "In progress",
    pending: "Pending",
    "needs-attention": "Needs attention",
    waiting: "Waiting for you",
  }[state];
}

function stateIcon(state: RowState) {
  return {
    completed: "✓",
    current: "●",
    pending: "○",
    "needs-attention": "!",
    waiting: "…",
  }[state];
}

// Screen 12: status is supplied by the route's authenticated Convex subscription.
export function CoachStages({
  coachStages,
  job,
  backHref = "/sessions",
  terminalState,
  renderTerminal,
}: CoachStagesProps) {
  const progress = validProgress(job.progress) ? job.progress : undefined;
  const showProgress = progress !== undefined;
  const showProgressLabel = typeof job.progressLabel === "string" && job.progressLabel.length > 0;

  return (
    <main className={styles.screen}>
      <a className={styles.back} href={backHref}>Back to Sessions</a>
      <header className={styles.header}>
        <p className={styles.eyebrow}>PROCESSING</p>
        <h1>Your draft</h1>
        <p className={styles.privateNote}>Only you can see this draft.</p>
        <p aria-live="polite" className={styles.status} role="status">{statusCopy[job.status]}</p>
      </header>

      {(showProgress || showProgressLabel) && (
        <section aria-label="Processing progress" className={styles.progressSection}>
          {showProgress && <progress aria-label="Processing progress" max={1} value={progress} />}
          {showProgressLabel && <p className={styles.progressLabel}>{job.progressLabel}</p>}
        </section>
      )}

      <ol aria-label="Processing stages" className={styles.list}>
        {coachStages.map((label, index) => {
          const state = rowState(job, label);
          return (
            <li className={styles.row} data-stage-state={state} key={`${index}-${label}`}>
              <span aria-hidden="true" className={`${styles.icon} ${styles[`icon${state}`]}`}>{stateIcon(state)}</span>
              <span className={styles.rowContent}>
                <span className={styles.label}>{label}</span>
                <span className={styles.rowStatus}>{stateText(state)}</span>
              </span>
            </li>
          );
        })}
      </ol>

      {terminalState && renderTerminal?.(terminalState)}
    </main>
  );
}
