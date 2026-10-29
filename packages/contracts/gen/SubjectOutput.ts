/* Generated from JSON Schema. Do not edit. */

export interface SubjectOutput {
  remarkId: string;
  target: {
    role: "batter" | "bowler" | "other";
    promptBox: {
      x1: number;
      y1: number;
      x2: number;
      y2: number;
    };
    promptPoint: {
      x: number;
      y: number;
    } | null;
    frameMs: number;
  };
  method: "anchor_reuse" | "reid_model" | "coach_tap";
  why: string;
  confidence: "high" | "medium" | "low";
  candidatesCount: number;
}
