/* Generated from JSON Schema. Do not edit. */

export interface CheckInput {
  remarkId: string;
  marks: {
    markId: string;
    markType: "circle" | "arrow" | "highlight" | "label";
    anchor: "box_center" | "box_top" | "box_bottom" | "box_left" | "box_right";
    arrowFrom: ("left" | "right" | "above" | "below") | null;
    startMs: number;
    endMs: number;
    labelSpan: {
      turnId: string;
      start: number;
      end: number;
    } | null;
    labelText: string;
    neutralLabel: ("Batter" | "Bowler" | "Player" | "Remark") | null;
  }[];
  trackFileRef: string;
  transcriptTurns: {
    turnId: string;
    text: string;
  }[];
  momentStartMs: number;
  momentEndMs: number;
}
