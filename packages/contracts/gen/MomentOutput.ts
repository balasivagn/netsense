/* Generated from JSON Schema. Do not edit. */

export interface MomentOutput {
  remarkId: string;
  startMs: number;
  endMs: number;
  keyframeMs: number;
  keyframeIdx: number;
  /**
   * @maxItems 2
   */
  candidates:
    | []
    | [
        {
          startMs: number;
          endMs: number;
        },
      ]
    | [
        {
          startMs: number;
          endMs: number;
        },
        {
          startMs: number;
          endMs: number;
        },
      ];
  why: string;
  confidence: "high" | "medium" | "low";
}
