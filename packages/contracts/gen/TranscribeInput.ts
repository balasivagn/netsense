/* Generated from JSON Schema. Do not edit. */

export interface TranscribeInput {
  audioWavKeys: {
    key: string;
    offsetMs: number;
    durationMs: number;
  }[];
  keywords: string[];
  languageBias: string[];
}
