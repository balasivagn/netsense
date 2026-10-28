/* Generated from JSON Schema. Do not edit. */

export interface RenderInput {
  kind: "preview" | "final";
  mode: "video" | "stills";
  proxyKey: string;
  durationMs: number;
  segments: {
    segmentId: string;
    startMs: number;
    endMs: number;
    annotationIds: string[];
    hash: string;
  }[];
  annotations: {
    annotationId: string;
    markType: "circle" | "arrow" | "highlight" | "label";
    anchor: "box_center" | "box_top" | "box_bottom" | "box_left" | "box_right";
    arrowFrom: ("left" | "right" | "above" | "below") | null;
    startMs: number;
    endMs: number;
    labelText: string;
    placedBy: "ai" | "coach";
    trackFileRef: string;
  }[];
  previousSegments: {
    segmentId: string;
    hash: string;
    key: string;
  }[];
}
