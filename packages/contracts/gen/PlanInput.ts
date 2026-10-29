/* Generated from JSON Schema. Do not edit. */

export interface PlanInput {
  session: {
    studentLabel: string;
    subjectRole: "batter" | "bowler" | "other";
  };
  turns: {
    turnId: string;
    startMs: number;
    endMs: number;
    speaker: string;
    text: string;
  }[];
}
