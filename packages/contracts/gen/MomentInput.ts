/* Generated from JSON Schema. Do not edit. */

export interface MomentInput {
  remarkId: string;
  coachWords: string;
  atMs: number;
  subjectRole: "batter" | "bowler" | "other";
  /**
   * @maxItems 26
   */
  frames: {
    idx: number;
    ms: number;
    key: string;
  }[];
  previousRemarkAtMs: number;
}
