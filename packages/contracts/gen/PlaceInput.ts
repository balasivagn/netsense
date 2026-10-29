/* Generated from JSON Schema. Do not edit. */

export interface PlaceInput {
  remarkId: string;
  coachWords: string;
  turnSpans: {
    turnId: string;
    length: number;
  }[];
  role: "batter" | "bowler" | "other";
  momentStartMs: number;
  momentEndMs: number;
  keyframeMs: number;
  boxAtKeyframe: {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  };
  coverage: number;
  /**
   * @minItems 1
   */
  allowedMarkTypes: [
    "circle" | "arrow" | "highlight" | "label",
    ...("circle" | "arrow" | "highlight" | "label")[],
  ];
  remarkNumber: number;
}
