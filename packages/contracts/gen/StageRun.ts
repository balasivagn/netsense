/* Generated from JSON Schema. Do not edit. */

export type ErrorCode =
  | "CONSENT_REQUIRED"
  | "UPLOAD_PART_FAILED"
  | "UPLOAD_CHECKSUM"
  | "UPLOAD_SIZE_MISMATCH"
  | "VIDEO_DECODE"
  | "AUDIO_DECODE"
  | "TRANSCRIBE_FAILED"
  | "NO_SPEECH"
  | "PLAN_FAILED"
  | "MOMENT_FAILED"
  | "SUBJECT_NEEDED"
  | "SUBJECT_NOT_FOUND"
  | "SUBJECT_SWAP"
  | "SEG_NO_TRACK"
  | "SEG_BAD_INPUT"
  | "RENDER_FAIL"
  | "BUDGET_SAM_FRAMES"
  | "BUDGET_TOKENS"
  | "BUDGET_DAILY"
  | "STAGE_TIMEOUT"
  | "SANDBOX_LOST"
  | "INFRA_CREATE"
  | "INFRA_EXEC"
  | "INFRA_NETWORK"
  | "VERBATIM_MISMATCH"
  | "CONTRACT_INVALID"
  | "LINK_WRONG_CODE"
  | "LINK_LOCKED"
  | "LINK_STOPPED";

export interface StageRun {
  jobId: string;
  sessionId: string;
  stage:
    | "transcode"
    | "transcribe"
    | "plan"
    | "moment"
    | "subject"
    | "track"
    | "place"
    | "check"
    | "render";
  remarkId: string | null;
  workerId: string;
  workerType: "agent" | "sub_agent" | "model" | "tool" | "rules";
  provider: "local" | "meta" | "fake" | "gemini" | "fireworks" | "baseten";
  modelVersion: string | null;
  promptHash: string | null;
  candidate: string | null;
  attempt: number;
  idempotencyKey: string;
  status:
    | "queued"
    | "running"
    | "done"
    | "failed"
    | "skipped"
    | "fallback"
    | "needs_coach";
  errorCode: ErrorCode | null;
  errorDetail: string | null;
  inputHash: string;
  outputRef: string | null;
  startedAt: number | null;
  endedAt: number | null;
  latencyMs: number | null;
  samFrames: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}
