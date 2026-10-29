/* Generated from JSON Schema. Do not edit. */

export interface CheckOutput {
  remarkId: string;
  verdicts: {
    markId: string;
    pass: boolean;
    reason:
      | "ok"
      | "no_player"
      | "subject_swap"
      | "low_coverage"
      | "outside_moment"
      | "label_mismatch"
      | "label_too_long";
  }[];
  remarkStatus: "ok" | "player_missing";
}
