/* Generated from JSON Schema. Do not edit. */

export interface TrackInput {
  remarkId: string;
  mode: "video" | "still";
  proxyKey: string;
  windowStartMs: number;
  windowEndMs: number;
  promptFrameMs: number;
  promptBox: {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  };
  promptPoint: {
    x: number;
    y: number;
  } | null;
  role: "batter" | "bowler" | "other";
  downsampleFps: number | null;
  proxySha256: string;
}
