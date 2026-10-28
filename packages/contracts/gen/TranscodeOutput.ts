/* Generated from JSON Schema. Do not edit. */

export interface TranscodeOutput {
  proxyKey: string;
  audioWavKeys: {
    key: string;
    offsetMs: number;
    durationMs: number;
  }[];
  audioM4aKey: string;
  durationMs: number;
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  keyframeIndexKey: string;
  sha256Verified: true;
}
