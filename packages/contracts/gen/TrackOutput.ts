/* Generated from JSON Schema. Do not edit. */

export interface TrackOutput {
  remarkId: string;
  trackId: string;
  role: "batter" | "bowler" | "other";
  mode: "video" | "still";
  fileRef: string;
  maskRef: string | null;
  coverage: number;
  framesBilled: number;
  cacheHit: boolean;
  swapSuspected: boolean;
  reassociations: number;
}
