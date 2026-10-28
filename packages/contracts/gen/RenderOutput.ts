/* Generated from JSON Schema. Do not edit. */

export interface RenderOutput {
  kind: "preview" | "final";
  mode: "video" | "stills";
  fileRef: string | null;
  stillRefs: {
    annotationId: string;
    key: string;
  }[];
  segmentRefs: {
    segmentId: string;
    hash: string;
    key: string;
  }[];
  durationMs: number;
}
