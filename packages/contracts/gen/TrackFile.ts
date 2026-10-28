/* Generated from JSON Schema. Do not edit. */

export interface TrackFile {
  fps: number;
  subjectOnly: true;
  frames: {
    ms: number;
    box: {
      x1: number;
      y1: number;
      x2: number;
      y2: number;
    };
    conf: number;
  }[];
  gaps: [number, number][];
  swaps: {
    ms: number;
    reason: "jump" | "reassociated";
  }[];
}
