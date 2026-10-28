/* Generated from JSON Schema. Do not edit. */

export interface MomentModelOutput {
  startIdx: number;
  endIdx: number;
  keyIdx: number;
  /**
   * @maxItems 2
   */
  alternates:
    | []
    | [
        {
          startIdx: number;
          endIdx: number;
        },
      ]
    | [
        {
          startIdx: number;
          endIdx: number;
        },
        {
          startIdx: number;
          endIdx: number;
        },
      ];
  why: string;
  confidence: "high" | "medium" | "low";
}
