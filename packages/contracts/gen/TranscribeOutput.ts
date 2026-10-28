/* Generated from JSON Schema. Do not edit. */

export interface TranscribeOutput {
  turns: {
    turnId: string;
    startMs: number;
    endMs: number;
    speaker: string;
    text: string;
  }[];
  audioDurationMs: number;
  providerSessionIds: string[];
}
