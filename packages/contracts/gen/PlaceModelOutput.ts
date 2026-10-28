/* Generated from JSON Schema. Do not edit. */

export interface PlaceModelOutput {
  /**
   * @minItems 1
   * @maxItems 3
   */
  marks:
    | [
        {
          markType: "circle" | "arrow" | "highlight" | "label";
          anchor:
            "box_center" | "box_top" | "box_bottom" | "box_left" | "box_right";
          arrowFrom: "left" | "right" | "above" | "below" | "none";
          startOffsetMs: number;
          endOffsetMs: number;
          label: {
            kind: "coach_span" | "neutral";
            span: {
              turnId: string;
              start: number;
              end: number;
            };
            neutral: "Batter" | "Bowler" | "Player" | "Remark" | "none";
          };
        },
      ]
    | [
        {
          markType: "circle" | "arrow" | "highlight" | "label";
          anchor:
            "box_center" | "box_top" | "box_bottom" | "box_left" | "box_right";
          arrowFrom: "left" | "right" | "above" | "below" | "none";
          startOffsetMs: number;
          endOffsetMs: number;
          label: {
            kind: "coach_span" | "neutral";
            span: {
              turnId: string;
              start: number;
              end: number;
            };
            neutral: "Batter" | "Bowler" | "Player" | "Remark" | "none";
          };
        },
        {
          markType: "circle" | "arrow" | "highlight" | "label";
          anchor:
            "box_center" | "box_top" | "box_bottom" | "box_left" | "box_right";
          arrowFrom: "left" | "right" | "above" | "below" | "none";
          startOffsetMs: number;
          endOffsetMs: number;
          label: {
            kind: "coach_span" | "neutral";
            span: {
              turnId: string;
              start: number;
              end: number;
            };
            neutral: "Batter" | "Bowler" | "Player" | "Remark" | "none";
          };
        },
      ]
    | [
        {
          markType: "circle" | "arrow" | "highlight" | "label";
          anchor:
            "box_center" | "box_top" | "box_bottom" | "box_left" | "box_right";
          arrowFrom: "left" | "right" | "above" | "below" | "none";
          startOffsetMs: number;
          endOffsetMs: number;
          label: {
            kind: "coach_span" | "neutral";
            span: {
              turnId: string;
              start: number;
              end: number;
            };
            neutral: "Batter" | "Bowler" | "Player" | "Remark" | "none";
          };
        },
        {
          markType: "circle" | "arrow" | "highlight" | "label";
          anchor:
            "box_center" | "box_top" | "box_bottom" | "box_left" | "box_right";
          arrowFrom: "left" | "right" | "above" | "below" | "none";
          startOffsetMs: number;
          endOffsetMs: number;
          label: {
            kind: "coach_span" | "neutral";
            span: {
              turnId: string;
              start: number;
              end: number;
            };
            neutral: "Batter" | "Bowler" | "Player" | "Remark" | "none";
          };
        },
        {
          markType: "circle" | "arrow" | "highlight" | "label";
          anchor:
            "box_center" | "box_top" | "box_bottom" | "box_left" | "box_right";
          arrowFrom: "left" | "right" | "above" | "below" | "none";
          startOffsetMs: number;
          endOffsetMs: number;
          label: {
            kind: "coach_span" | "neutral";
            span: {
              turnId: string;
              start: number;
              end: number;
            };
            neutral: "Batter" | "Bowler" | "Player" | "Remark" | "none";
          };
        },
      ];
  why: string;
}
