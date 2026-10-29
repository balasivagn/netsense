/* Generated from JSON Schema. Do not edit. */

export interface SubjectAnchorInput {
  proxyKey: string;
  subject: {
    frameMs: number;
    point: {
      x: number;
      y: number;
    };
    role: "batter" | "bowler" | "other";
    selectedBy: "coach";
    selectedAt: number;
  };
}
