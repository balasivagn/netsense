/* Generated from JSON Schema. Do not edit. */

export interface SubjectInput {
  remarkId: string;
  coachWords: string;
  subjectRole: "batter" | "bowler" | "other";
  referenceCropKey: string;
  anchorBox: {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  };
  anchorFrameMs: number;
  keyframeKey: string;
  keyframeMs: number;
  pointPrompt: {
    x: number;
    y: number;
  } | null;
}
